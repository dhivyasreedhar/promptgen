import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { buildConnectors } from "../connectors/index.js";
import { EvidenceExtractor } from "../evidence/extractor.js";
import { createPromptModel, type ModelReview } from "../model/provider.js";
import { discoverOpportunities } from "../opportunities/discover.js";
import { validateCandidates } from "../prompts/validate.js";
import { selectPrompts, summarizeCoverage } from "../prompts/select.js";
import { attachPromptContext } from "../prompts/provenance.js";
import { repairCandidates } from "../prompts/repair.js";
import { planEvidenceNeeds } from "../retrieval/planner.js";
import { EvidenceRetriever } from "../retrieval/retriever.js";
import { HostedEvidenceRetriever } from "../retrieval/hosted-retriever.js";
import { embeddingInputHash, OllamaEmbeddingProvider, type EmbeddingProvider } from "../retrieval/embeddings.js";
import { EvidenceDatabase } from "../store/database.js";
import { PostgresMetadataStore } from "../store/postgres-metadata.js";
import { artifactObjectKey, EncryptedFileObjectStore } from "../store/object-store.js";
import { TraceRecorder } from "../trace.js";
import type { CompanyConfig, EvidenceNeed, EvidenceRecord, MissingEvidence, RunResult, ValidatedCandidate } from "../types.js";
import { hash, isoNow, log, newRunId } from "../util.js";
import { classifyFailure } from "../operations/errors.js";
import { operationalMetrics } from "../operations/metrics.js";
import { transformEvidenceForExternal } from "../privacy/transform.js";

export interface RunOptions { fixtures: boolean; timeoutMs?: number; signal?: AbortSignal }

export async function runCompany(config: AppConfig, company: CompanyConfig, options: RunOptions): Promise<RunResult> {
  const runStarted = performance.now();
  const startedAt = isoNow();
  const runId = newRunId(company.id);
  const runDirectory = path.join(config.runsDir, company.id, runId);
  await mkdir(runDirectory, { recursive: true });
  using db = new EvidenceDatabase(config.dbPath);
  db.startRun(runId, company.id, startedAt);
  const trace = new TraceRecorder(db, runId, company.id);
  const model = createPromptModel(config);
  const metadata = config.postgresUrl ? new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName) : undefined;
  const objectStore = config.objectEncryptionKey ? new EncryptedFileObjectStore(config.objectsDir, config.objectEncryptionKey) : undefined;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason ?? new Error("Run cancelled"));
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  if (options.signal?.aborted) relayAbort();
  const timeout = setTimeout(() => controller.abort(new Error("Run deadline exceeded")), options.timeoutMs ?? 15 * 60_000);
  timeout.unref();
  const metrics = { artifactsIngested: 0, evidenceExtracted: 0, evidenceRetrieved: 0, opportunities: 0, candidatesGenerated: 0, candidatesAccepted: 0 };
  const warnings: string[] = [];

  try {
    await metadata?.startRun(company, runId, startedAt, model.name);
    trace.record("run", "started", { fixtures: options.fixtures, provider: model.name, enabledSources: company.enabledSources });
    for (const connector of buildConnectors(config, options.fixtures).filter(item => company.enabledSources.includes(item.source))) {
      let sourceCount = 0;
      let collectedCount = 0;
      try {
        const collected = [];
        for await (const artifact of connector.collect(company, controller.signal)) {
          collectedCount += 1;
          collected.push({ artifact, contentHash: hash(artifact.content) });
        }
        const objectKeys = new Map<string, string>();
        if (objectStore) {
          for (let offset = 0; offset < collected.length; offset += 50) {
            await Promise.all(collected.slice(offset, offset + 50).map(async ({ artifact }) => {
              const key = artifactObjectKey(config.tenantId, company.id, artifact.id);
              await objectStore.put(key, artifact.content); objectKeys.set(artifact.id, key);
            }));
          }
        }
        await metadata?.syncArtifacts(company, collected.map(item => item.artifact), new Map(collected.map(item => [item.artifact.id, item.contentHash])), objectKeys);
        sourceCount = db.upsertArtifacts(collected);
        metrics.artifactsIngested += sourceCount;
        if (collectedCount === 0) warnings.push(`${connector.source} returned no artifacts`);
        db.recordSourceHealth({ companyId: company.id, source: connector.source, status: collectedCount === 0 ? "empty" : "healthy",
          checkedAt: isoNow(), collectedArtifacts: collectedCount, changedArtifacts: sourceCount });
        trace.record("ingest", "source-complete", { source: connector.source, collectedArtifacts: collectedCount, changedArtifacts: sourceCount });
      } catch (error) {
        const message = `${connector.source} collection failed: ${errorMessage(error)}`;
        warnings.push(message);
        db.recordSourceHealth({ companyId: company.id, source: connector.source, status: "degraded", checkedAt: isoNow(),
          collectedArtifacts: collectedCount, changedArtifacts: sourceCount, error: errorMessage(error) });
        trace.record("ingest", "source-failed", { source: connector.source, error: errorMessage(error) });
      }
    }

    const extractor = new EvidenceExtractor();
    const pending = db.pendingArtifacts(company.id, extractor.version);
    for (let offset = 0; offset < pending.length; offset += 500) {
      const batch = pending.slice(offset, offset + 500);
      const completed: Array<{ artifactId: string; extractorVersion: string; records: ReturnType<EvidenceExtractor["extract"]> }> = [];
      const sourceCounts: Record<string, { artifacts: number; evidence: number }> = {};
      for (const artifact of batch) {
        try {
          const records = extractor.extract(artifact);
          completed.push({ artifactId: artifact.id, extractorVersion: extractor.version, records });
          metrics.evidenceExtracted += records.length;
          const count = sourceCounts[artifact.source] ?? { artifacts: 0, evidence: 0 };
          count.artifacts += 1; count.evidence += records.length; sourceCounts[artifact.source] = count;
        } catch (error) {
          trace.record("extract", "artifact-failed", { source: artifact.source, error: errorMessage(error), retryable: true }, artifact.id);
        }
      }
      db.replaceEvidenceBatch(completed);
      if (metadata) {
        // A local artifact may predate hosted metadata or a connector may be empty
        // during this run. Preserve the FK invariant for every extraction batch.
        await metadata.syncArtifacts(company, batch, new Map(batch.map(artifact => [artifact.id, hash(artifact.content)])));
        await metadata.replaceEvidence(company, completed);
      }
      trace.record("extract", "batch-complete", { offset, size: batch.length, extractorVersion: extractor.version, sourceCounts });
    }

    const tags = db.evidenceTagsForCompany(company.id).filter(tag => tag !== "operations");
    if (metadata) {
      const localEvidence = db.evidenceForCompany(company.id);
      const hostedCounts = await metadata.contextCounts(company.id);
      const hostedExtractorCount = await metadata.evidenceCountForExtractor(company.id, extractor.version);
      const shouldRefreshRelations = metrics.evidenceExtracted > 0 || hostedCounts.evidence !== localEvidence.length || hostedExtractorCount < localEvidence.length;
      if (hostedCounts.evidence !== localEvidence.length || hostedExtractorCount < localEvidence.length) {
        // Evidence has a strict hosted FK to artifacts. A connector that returns
        // nothing today may still have valid current context in the local cache.
        const localArtifacts = db.artifactsForCompany(company.id);
        await metadata.syncArtifacts(company, localArtifacts, new Map(localArtifacts.map(artifact => [artifact.id, hash(artifact.content)])));
        const grouped = new Map<string, EvidenceRecord[]>();
        for (const record of localEvidence) grouped.set(record.artifactId, [...(grouped.get(record.artifactId) ?? []), record]);
        await metadata.replaceEvidence(company, [...grouped].map(([artifactId, records]) => ({ artifactId, extractorVersion: records[0]?.extractorVersion ?? "unknown", records })));
        trace.record("hosted-context", "evidence-backfilled", { priorCount: hostedCounts.evidence, hostedExtractorCount, localCount: localEvidence.length,
          extractorVersion: extractor.version });
      }
      if (shouldRefreshRelations) {
        const relations = await metadata.refreshEvidenceRelations(company.id);
        trace.record("hosted-context", "relations-refreshed", relations);
      }
    }
    const embeddingProvider = config.embeddingProvider === "ollama"
      ? new OllamaEmbeddingProvider(config.embeddingModel, config.embeddingDimensions, config.ollamaUrl)
      : undefined;
    if (metadata && embeddingProvider && config.embeddingRunLimit > 0) {
      await backfillEmbeddings(metadata, company.id, embeddingProvider, config.embeddingRunLimit, trace, controller.signal);
    }
    const localRetriever = new EvidenceRetriever(db);
    const hostedRetriever = metadata ? new HostedEvidenceRetriever(metadata, db, embeddingProvider,
      status => trace.record("retrieve", `semantic-${status.status}`, status),
      error => trace.record("retrieve", "hosted-degraded", { error, fallback: "local-recall" })) : undefined;
    const retrieve = (needs: ReturnType<typeof planEvidenceNeeds>) => hostedRetriever ? hostedRetriever.retrieve(company.id, needs) : Promise.resolve(localRetriever.retrieve(company.id, needs));
    const broadPacks = await retrieve(planEvidenceNeeds(company, []));
    const broadEvidence = uniqueEvidence(broadPacks.flatMap(pack => pack.records.map(item => item.evidence)));
    tracePrivacy(trace, broadEvidence, "topic-planning");
    const modelTopics = await cachedModelCall(db, trace, model.name, "plan-topics", { company, broadEvidence }, () => model.planTopics(company, broadEvidence, controller.signal));
    const topics = dedupeTopics([...modelTopics, ...tags.map(slug => ({ slug, query: slug.replaceAll("-", " ") }))]);
    trace.record("retrieve", "topic-plan-created", { provider: model.name, broadEvidenceIds: broadEvidence.map(item => item.id), topics });
    const needs = planEvidenceNeeds(company, topics);
    trace.record("retrieve", "plan-created", { needs });
    const packs = await retrieve(needs);
    metrics.evidenceRetrieved = new Set(packs.flatMap(pack => pack.records.map(item => item.evidence.id))).size;
    for (const pack of packs) trace.record("retrieve", pack.missing ? "need-missing" : "need-satisfied", {
      query: pack.need.query,
      records: pack.records.map(record => ({ id: record.evidence.id, source: record.evidence.source, kind: record.evidence.kind, score: record.score, reasons: record.reasons })),
      reconciliation: pack.reconciliation ?? [],
    }, pack.need.id);

    const opportunities = discoverOpportunities(company.id, packs);
    metrics.opportunities = opportunities.length;
    for (const opportunity of opportunities) trace.record("opportunity", "discovered", opportunity as unknown as Record<string, unknown>, opportunity.id);

    const relevantEvidenceIds = [...new Set([...broadEvidence.map(record => record.id), ...packs.flatMap(pack => pack.records.map(item => item.evidence.id))])];
    const evidenceById = new Map(db.evidenceByIds(relevantEvidenceIds).map(record => [record.id, record]));
    tracePrivacy(trace, [...evidenceById.values()], "candidate-generation");
    const generatedCandidates = await cachedModelCall(db, trace, model.name, "generate-v3-recommendation-seeking", { company, opportunities, evidence: opportunities.flatMap(item => item.evidenceIds.map(id => evidenceById.get(id))) }, () => model.generate(company, opportunities, evidenceById, controller.signal));
    const candidateNeeds: EvidenceNeed[] = generatedCandidates.slice(0, 60).map(candidate => ({
      id: `candidate:${candidate.id}`, query: candidate.text, kinds: ["demand", "language", "capability", "constraint"],
      reason: "Candidate-specific entailment and conflict check", preferredSources: ["web", "github", "gsc", "intercom", "slack", "calls", "linear"],
    }));
    const candidatePacks = await retrieve(candidateNeeds);
    const candidatePackById = new Map(candidatePacks.map(pack => [pack.need.id.slice("candidate:".length), pack]));
    for (const pack of candidatePacks) {
      for (const item of pack.records) evidenceById.set(item.evidence.id, item.evidence);
      trace.record("candidate-retrieve", pack.missing ? "candidate-context-missing" : "candidate-context-found", {
        query: pack.need.query, evidenceIds: pack.records.map(item => item.evidence.id), reconciliation: pack.reconciliation ?? [],
      }, pack.need.id);
    }
    const candidates = generatedCandidates.map(candidate => ({ ...candidate,
      evidenceIds: [...new Set([...candidate.evidenceIds, ...(candidatePackById.get(candidate.id)?.records.map(item => item.evidence.id) ?? [])])].slice(0, 8),
    }));
    for (const candidate of candidates) {
      const opportunity = opportunities.find(item => item.id === candidate.opportunityId);
      if (opportunity) opportunity.evidenceIds = [...new Set([...opportunity.evidenceIds, ...candidate.evidenceIds])];
    }
    metrics.candidatesGenerated = candidates.length;
    trace.record("generate", "candidates-created", { provider: model.name, count: candidates.length });
    const repairs = repairCandidates(candidates, opportunities, evidenceById);
    const eligibleCandidates = repairs.map(item => item.repaired);
    for (const repair of repairs.filter(item => item.changes.length > 0)) trace.record("repair", "candidate-transformed", {
      originalId: repair.originalId, repairedId: repair.repaired.id, changes: repair.changes,
      text: repair.repaired.text, evidenceIds: repair.repaired.evidenceIds,
    }, repair.repaired.id);

    // This is the sole eligibility path. Rewrites, repairs and backfills must return here before selection.
    const deterministic = validateCandidates(company, eligibleCandidates, opportunities, evidenceById);
    const reviewable = deterministic.filter(item => item.accepted);
    tracePrivacy(trace, reviewable.flatMap(item => item.evidenceIds.map(id => evidenceById.get(id))).filter((item): item is EvidenceRecord => Boolean(item)), "candidate-review");
    const modelReviews = await cachedModelCall(db, trace, model.name, "review-v4-recommendation-seeking", { company, candidates: reviewable, evidence: reviewable.flatMap(item => item.evidenceIds.map(id => evidenceById.get(id))) }, () => model.review(company, reviewable, evidenceById, controller.signal));
    const reviewById = new Map(modelReviews.map(review => [review.candidateId, review]));
    let validated = attachPromptContext(applyModelReviews(deterministic, reviewById, evidenceById), opportunities, evidenceById);
    const guidance = metadata ? await metadata.promptGuidance(company.id) : { rejected: [], preferred: [], benchmark: [], rules: [] };
    validated = applyPromptGuidance(validated, new Set(guidance.rejected), guidance.rules);
    const preferredPromptIds = new Set(guidance.preferred);
    trace.record("feedback", "guidance-applied", { rejectedPromptIds: guidance.rejected, preferredPromptIds: guidance.preferred });
    trace.record("review", "model-critique-complete", { provider: model.name, requested: reviewable.length, returned: modelReviews.length, accepted: validated.filter(item => item.accepted).length });
    let selection = selectPrompts(validated, 10, preferredPromptIds, new Set(guidance.benchmark));

    // Diversity can make a large valid pool select fewer than ten. Retry only on
    // uncovered evidence packs, then send every backfill candidate through the
    // identical repair, deterministic validation, and independent critic gates.
    if (selection.discovery.length < 10) {
      const coveredOpportunities = new Set(selection.discovery.map(item => item.opportunityId));
      const uncovered = opportunities.filter(item => !coveredOpportunities.has(item.id));
      trace.record("backfill", "started", { missing: 10 - selection.discovery.length, uncoveredOpportunityIds: uncovered.map(item => item.id) });
      if (uncovered.length > 0) {
        const generatedBackfill = await cachedModelCall(db, trace, model.name, "generate-backfill-v2-recommendation-seeking", {
          company, missing: 10 - selection.discovery.length, opportunities: uncovered,
          evidence: uncovered.flatMap(item => item.evidenceIds.map(id => evidenceById.get(id))),
        }, () => model.generate(company, uncovered, evidenceById, controller.signal));
        const existingIds = new Set(candidates.map(item => item.id));
        const backfillCandidates = generatedBackfill.filter(item => !existingIds.has(item.id));
        metrics.candidatesGenerated += backfillCandidates.length;
        const backfillRepairs = repairCandidates(backfillCandidates, uncovered, evidenceById);
        const backfillDeterministic = validateCandidates(company, backfillRepairs.map(item => item.repaired), uncovered, evidenceById);
        const backfillReviewable = backfillDeterministic.filter(item => item.accepted);
        const backfillReviews = await cachedModelCall(db, trace, model.name, "review-backfill-v4-recommendation-seeking", {
          company, candidates: backfillReviewable,
          evidence: backfillReviewable.flatMap(item => item.evidenceIds.map(id => evidenceById.get(id))),
        }, () => model.review(company, backfillReviewable, evidenceById, controller.signal));
        const backfillById = new Map(backfillReviews.map(review => [review.candidateId, review]));
        const validatedBackfill = attachPromptContext(applyModelReviews(backfillDeterministic, backfillById, evidenceById), uncovered, evidenceById);
        validated = applyPromptGuidance([...validated, ...validatedBackfill], new Set(guidance.rejected), guidance.rules);
        selection = selectPrompts(validated, 10, preferredPromptIds, new Set(guidance.benchmark));
        trace.record("backfill", "completed", {
          generated: backfillCandidates.length, reviewable: backfillReviewable.length,
          accepted: validatedBackfill.filter(item => item.accepted).length, discoveryCount: selection.discovery.length,
        });
      }
    }

    metrics.candidatesAccepted = validated.filter(item => item.accepted).length;
    for (const candidate of validated) trace.record("validate", candidate.accepted ? "accepted" : "rejected", {
      text: candidate.text, score: candidate.score, evidenceIds: candidate.evidenceIds, opportunityId: candidate.opportunityId, findings: candidate.findings,
      semanticKey: candidate.semanticKey,
    }, candidate.id);

    const missingEvidence: MissingEvidence[] = selection.discovery.length === 10 ? [] : packs.filter(pack => pack.missing).map(pack => ({
      need: pack.need.query, reason: pack.need.reason, recommendedSources: pack.need.preferredSources,
    }));
    if (selection.discovery.length < 10) missingEvidence.unshift({
      need: `${10 - selection.discovery.length} additional supported discovery opportunities`,
      reason: "The validated candidate pool could not honestly support ten distinct prompts.",
      recommendedSources: ["gsc", "intercom", "slack", "calls", "github"],
    });
    const status = selection.discovery.length === 10 ? "complete" as const : "insufficient_evidence" as const;
    const coverage = summarizeCoverage(selection.discovery);
    let promptLifecycle: RunResult["promptLifecycle"];
    if (metadata) {
      const previousKeys = new Set(await metadata.activePromptKeys(company.id));
      const currentKeys = new Set(selection.discovery.map(prompt => prompt.semanticKey ?? prompt.id));
      const added = [...currentKeys].filter(key => !previousKeys.has(key));
      const retained = [...currentKeys].filter(key => previousKeys.has(key));
      const removed = [...previousKeys].filter(key => !currentKeys.has(key));
      promptLifecycle = { added: added.length, retained: retained.length, removed: removed.length,
        churnRate: (added.length + removed.length) / Math.max(1, new Set([...previousKeys, ...currentKeys]).size) };
      trace.record("prompt-lifecycle", "daily-diff", {
        added, retained, removed, churnRate: promptLifecycle.churnRate,
      });
    }
    trace.record("select", "completed", { status, discoveryCount: selection.discovery.length, boundaryCount: selection.boundaries.length, missingEvidence });
    const tracePath = await trace.writeManifest(runDirectory);
    const result: RunResult = {
      schemaVersion: 1, runId, companyId: company.id, companyName: company.name, domain: company.domain, status,
      startedAt, completedAt: isoNow(), provider: model.name, discoveryPrompts: selection.discovery,
      boundaryPrompts: selection.boundaries, missingEvidence, metrics, tracePath, warnings,
      coverage,
      ...(promptLifecycle ? { promptLifecycle } : {}),
    };
    await writeResult(runDirectory, result);
    db.finishRun(result);
    await metadata?.finishRun(company, result, db.sourceHealth(company.id), db.traceForRun(runId));
    log("info", "run.completed", { runId, companyId: company.id, status, prompts: selection.discovery.length, provider: model.name });
    operationalMetrics.increment("promptgen_runs_total", { status, company: company.id });
    operationalMetrics.observe("promptgen_run_duration_seconds", (performance.now() - runStarted) / 1000, { status, company: company.id });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const failure = classifyFailure(error);
    trace.record("run", "failed", { error: message, ...failure });
    const tracePath = await trace.writeManifest(runDirectory);
    const result: RunResult = {
      schemaVersion: 1, runId, companyId: company.id, companyName: company.name, domain: company.domain,
      status: "failed", startedAt, completedAt: isoNow(), provider: model.name, discoveryPrompts: [], boundaryPrompts: [],
      missingEvidence: [], metrics, tracePath, warnings, error: message, failure,
    };
    await writeResult(runDirectory, result);
    db.finishRun(result);
    if (metadata) {
      try { await metadata.finishRun(company, result, db.sourceHealth(company.id), db.traceForRun(runId)); }
      catch (metadataError) { warnings.push(`Hosted metadata sync failed: ${errorMessage(metadataError)}`); }
    }
    log("error", "run.failed", { runId, companyId: company.id, error: message });
    operationalMetrics.increment("promptgen_runs_total", { status: "failed", company: company.id, errorClass: failure.class });
    operationalMetrics.observe("promptgen_run_duration_seconds", (performance.now() - runStarted) / 1000, { status: "failed", company: company.id });
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relayAbort);
    await metadata?.close();
  }
}

async function backfillEmbeddings(metadata: PostgresMetadataStore, companyId: string, provider: EmbeddingProvider,
  limit: number, trace: TraceRecorder, signal: AbortSignal): Promise<void> {
  try {
    const pending = await metadata.evidenceMissingEmbeddings(companyId, provider.provider, provider.model, limit);
    let completed = 0;
    for (let offset = 0; offset < pending.length; offset += 64) {
      signal.throwIfAborted();
      const batch = pending.slice(offset, offset + 64);
      const vectors = await provider.embedDocuments(batch.map(item => item.claim), signal);
      await metadata.writeEmbeddings(batch.map((item, index) => ({ id: item.id, embedding: vectors[index]!, inputHash: embeddingInputHash(item.claim) })),
        provider.provider, provider.model, provider.dimensions);
      completed += batch.length;
    }
    trace.record("embed", "backfill-complete", { provider: provider.provider, model: provider.model,
      dimensions: provider.dimensions, embedded: completed, remainingMayExist: completed === limit });
  } catch (error) {
    // Semantic indexing is an enrichment. Preserve instant results through lexical retrieval.
    trace.record("embed", "backfill-degraded", { provider: provider.provider, model: provider.model,
      error: error instanceof Error ? error.message : String(error) });
  }
}

async function writeResult(directory: string, result: RunResult): Promise<void> {
  const temporary = path.join(directory, "result.json.tmp");
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, path.join(directory, "result.json"));
  const markdown = [
    `# ${result.companyName} tracking prompts`, "", `Status: **${result.status}**`, `Provider: \`${result.provider}\``, "",
    ...result.discoveryPrompts.flatMap((prompt, index) => [`${index + 1}. ${prompt.text}`, `   - Evidence: ${prompt.evidenceIds.join(", ")}`]),
    "", "## Boundary prompts", "", ...(result.boundaryPrompts.length ? result.boundaryPrompts.map(prompt => `- ${prompt.text}`) : ["None."]),
  ].join("\n");
  await writeFile(path.join(directory, "prompts.md"), `${markdown}\n`, "utf8");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function uniqueEvidence<T extends { id: string }>(records: T[]): T[] {
  return [...new Map(records.map(record => [record.id, record])).values()];
}

function dedupeTopics(topics: Array<{ slug: string; query: string }>): Array<{ slug: string; query: string }> {
  return [...new Map(topics.map(topic => [topic.slug, topic])).values()].slice(0, 24);
}

function applyModelReviews(
  candidates: ValidatedCandidate[],
  reviewById: Map<string, ModelReview>,
  evidenceById: Map<string, EvidenceRecord>,
): ValidatedCandidate[] {
  return candidates.map(candidate => {
    if (!candidate.accepted) return candidate;
    const review = reviewById.get(candidate.id);
    if (!review) return { ...candidate, accepted: false, findings: [...candidate.findings, { code: "review-missing", severity: "fatal" as const, message: "Independent model review was missing." }] };
    const relevantIds = [...new Set(review.relevantEvidenceIds)].filter(id => candidate.evidenceIds.includes(id) && evidenceById.has(id));
    const relevantRecords = relevantIds.map(id => evidenceById.get(id)!);
    const hasDemand = relevantRecords.some(record => record.kind === "demand" || record.kind === "language");
    const hasCapability = relevantRecords.some(record => record.kind === "capability" || (record.kind === "change" && record.lifecycle === "confirmed"));
    const publicInference = candidate.evidenceBasis === "public-inference" && relevantRecords.length > 0 && relevantRecords.every(record => record.visibility === "public");
    const demandPasses = publicInference || (review.demandSupported && hasDemand);
    const modelFindings = [
      ...(!review.supported ? [{ code: "model-unsupported", severity: "fatal" as const, message: review.findings.join("; ") || "Model critic found insufficient evidence support." }] : []),
      ...(!demandPasses ? [{ code: "demand-not-entailed", severity: "fatal" as const, message: "No independently verified demand evidence entails this question." }] : []),
      ...(!review.capabilitySupported || !hasCapability ? [{ code: "capability-not-entailed", severity: "fatal" as const, message: "No independently verified capability evidence entails this question." }] : []),
      ...(!review.usable ? [{ code: "model-unusable", severity: "fatal" as const, message: review.findings.join("; ") || "Model critic found the prompt unusable." }] : []),
      ...(review.findings.includes("provider-review-schema-fallback") ? [{ code: "critic-degraded", severity: "warning" as const,
        message: "Provider returned malformed critic output; deterministic evidence gates were used and this prompt should receive human review." }] : []),
    ];
    return {
      ...candidate, evidenceIds: relevantIds,
      accepted: candidate.accepted && review.supported && demandPasses && review.capabilitySupported && hasCapability && review.usable,
      score: (candidate.score + review.score) / 2, findings: [...candidate.findings, ...modelFindings], semanticKey: review.semanticKey,
    };
  });
}

export function applyPromptGuidance(candidates: ValidatedCandidate[], rejected: Set<string>, rules: Array<{ reason: string; dimension: string; value: string }> = []): ValidatedCandidate[] {
  return candidates.map(candidate => {
    const direct = rejected.has(candidate.id) || rejected.has(candidate.opportunityId) || Boolean(candidate.semanticKey && rejected.has(candidate.semanticKey));
    const rule = rules.find(item => item.dimension === "semanticKey" ? item.value === candidate.semanticKey :
      candidate.coverage?.[item.dimension as keyof NonNullable<ValidatedCandidate["coverage"]>] === item.value);
    return direct || rule ? { ...candidate, accepted: false,
      findings: [...candidate.findings, { code: rule ? `human-${rule.reason}` : "human-rejected", severity: "fatal" as const,
        message: rule ? `A set-level customer rule rejected this ${rule.dimension}.` : "A user rejected this stable prompt in a prior run." }] } : candidate;
  });
}

function tracePrivacy(trace: TraceRecorder, records: EvidenceRecord[], purpose: string): void {
  const unique = uniqueEvidence(records);
  const audits = unique.map(record => transformEvidenceForExternal(record).audit);
  trace.record("privacy", "external-context-transformed", {
    purpose, records: audits.length, blocked: audits.filter(item => item.rules.includes("blocked-never-expose")).length,
    transformations: audits.map(item => ({ evidenceId: item.evidenceId, policy: item.policy, inputHash: item.inputHash,
      outputHash: item.outputHash, rules: item.rules, safePreview: item.safePreview })),
  });
}

async function cachedModelCall<T>(
  db: EvidenceDatabase,
  trace: TraceRecorder,
  provider: string,
  operation: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const key = hash(JSON.stringify({ contractVersion: "prompt-pipeline-v4", provider, operation, input }));
  const cached = db.getModelCache<T>(key);
  if (cached !== undefined) {
    trace.record("model", "cache-hit", { provider, operation, key });
    return cached;
  }
  const value = await execute();
  db.setModelCache(key, provider, operation, value);
  trace.record("model", "cache-write", { provider, operation, key });
  return value;
}
