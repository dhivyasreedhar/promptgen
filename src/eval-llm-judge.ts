import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { transformEvidenceForExternal } from "./privacy/transform.js";
import { EvidenceDatabase } from "./store/database.js";
import { rankCandidatePool } from "./retrieval/retriever.js";
import type { EvidenceKind, EvidenceNeed } from "./types.js";
import { normalizeText, stableId } from "./util.js";

const relevanceSchema = z.enum(["relevant", "partial", "irrelevant", "forbidden"]);
const retrievalResultSchema = z.object({ results: z.array(z.object({
  caseId: z.string(), confidence: z.number().min(0).max(1), missingEvidenceLikely: z.boolean(), notes: z.string().max(300),
  labels: z.array(z.object({ evidenceId: z.string(), relevance: relevanceSchema })),
})) });
const promptResultSchema = z.object({ results: z.array(z.object({
  caseId: z.string(), buyerIntent: z.number().int().min(1).max(5), recommendationLikelihood: z.number().int().min(1).max(5),
  evidenceEntailment: z.number().int().min(1).max(5), distinctness: z.number().int().min(1).max(5), naturalness: z.number().int().min(1).max(5),
  accept: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().max(300),
})) });

type RetrievalResult = z.infer<typeof retrievalResultSchema>["results"][number];
export type PromptJudgeResult = z.infer<typeof promptResultSchema>["results"][number];
type PromptResult = PromptJudgeResult;
type JudgeFile = { schemaVersion: 1; provider: string; updatedAt: string; retrieval: Record<string, { a?: RetrievalResult; b?: RetrievalResult }>; prompts: Record<string, { a?: PromptResult; b?: PromptResult }> };
type Corpus = { generatedAt?: string; cases: Array<Record<string, unknown>> };

export interface LlmJudgeReport {
  provider: string;
  retrieval: { total: number; twiceJudged: number; agreement: number; poolRecordRecallAt12: number; uniqueClaimRecallAt12: number; precisionAt12: number; forbiddenHitRate: number; flaggedForHuman: string[] };
  prompts: {
    total: number; twiceJudged: number;
    pipelineAccepted: PromptJudgeAggregate;
    pipelineRejected: PromptJudgeAggregate;
    flaggedForHuman: string[];
  };
}

interface PromptJudgeAggregate {
  total: number;
  judgeAcceptanceRate: number;
  averageBuyerIntent: number;
  averageRecommendationLikelihood: number;
  averageEvidenceEntailment: number;
  averageDistinctness: number;
  averageNaturalness: number;
}

export async function runOpenAiJudge(config: AppConfig): Promise<LlmJudgeReport> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required for the independent judge");
  const client = new OpenAI({ apiKey: config.openaiApiKey, timeout: config.modelTimeoutMs, maxRetries: 3 });
  const directory = path.join(config.rootDir, "eval", "annotations");
  const [retrieval, prompts] = await Promise.all([loadCorpus(path.join(directory, "retrieval.json")), loadCorpus(path.join(directory, "prompts.json"))]);
  const outputPath = path.join(directory, "openai-judgments.json");
  const stored = await loadJudge(outputPath, `openai:${config.openaiJudgeModel}`);
  using db = new EvidenceDatabase(config.dbPath);
  for (const pass of ["a", "b"] as const) {
    for (let retry = 0; retry < 4 && retrieval.cases.some(item => !stored.retrieval[String(item.id)]?.[pass]); retry++)
      await judgeRetrieval(client, config.openaiJudgeModel, retrieval, stored, db, pass, outputPath);
    for (let retry = 0; retry < 4 && prompts.cases.some(item => !stored.prompts[String(item.id)]?.[pass]); retry++)
      await judgePrompts(client, config.openaiJudgeModel, prompts, stored, db, pass, outputPath);
  }
  return report(stored, retrieval, prompts);
}

export async function readOpenAiJudgeReport(config: AppConfig): Promise<LlmJudgeReport> {
  const directory = path.join(config.rootDir, "eval", "annotations");
  const [retrieval, prompts, stored] = await Promise.all([
    loadCorpus(path.join(directory, "retrieval.json")), loadCorpus(path.join(directory, "prompts.json")),
    loadJudge(path.join(directory, "openai-judgments.json")),
  ]);
  return report(stored, retrieval, prompts);
}

/** Judge a current production candidate set twice, reversing evidence order on pass B. */
export async function judgeCurrentPrompts(config: AppConfig, items: Array<{ caseId: string; prompt: string; evidence: Array<{ id: string; source: string; kind: string; text: string }> }>): Promise<{ a: PromptJudgeResult[]; b: PromptJudgeResult[] }> {
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is required for the live prompt judge");
  const client = new OpenAI({ apiKey: config.openaiApiKey, timeout: config.modelTimeoutMs, maxRetries: 3 });
  const run = async (pass: "a" | "b") => {
    const payload = items.map(item => ({ ...item, evidence: pass === "b" ? [...item.evidence].reverse() : item.evidence }));
    const response = await client.responses.create({ model: config.openaiJudgeModel,
      instructions: PROMPT_INSTRUCTIONS, input: JSON.stringify(payload),
      text: { format: { type: "json_schema", name: "current_prompt_judgments", schema: promptJsonSchema, strict: true } } });
    if (!response.output_text) throw new Error("OpenAI returned no live prompt judgments");
    const parsed = promptResultSchema.parse(JSON.parse(response.output_text)).results;
    const allowed = new Set(items.map(item => item.caseId));
    return parsed.filter(item => allowed.has(item.caseId));
  };
  const [a, b] = await Promise.all([run("a"), run("b")]);
  return { a, b };
}

export async function rerankFrozenRetrievalCorpus(config: AppConfig): Promise<LlmJudgeReport> {
  const directory = path.join(config.rootDir, "eval", "annotations");
  const retrievalPath = path.join(directory, "retrieval.json");
  const [retrieval, prompts, stored, frozenEvidence] = await Promise.all([
    loadCorpus(retrievalPath), loadCorpus(path.join(directory, "prompts.json")),
    loadJudge(path.join(directory, "openai-judgments.json")), loadFrozenEvidence(path.join(directory, "evidence.json")),
  ]);
  using db = new EvidenceDatabase(config.dbPath);
  const evaluationTime = retrieval.generatedAt ? Date.parse(retrieval.generatedAt) : Date.now();
  for (const item of retrieval.cases) {
    const companyId = String(item.companyId);
    const ids = item.candidateEvidenceIds as string[]; const byId = new Map(ids.flatMap(id => {
      const record = frozenEvidence.get(id); return record ? [record] : [];
    }).map(record => [record.id, record]));
    if (byId.size !== ids.length) for (const record of db.evidenceByIds(ids.filter(id => !byId.has(id)))) byId.set(record.id, record);
    const matches = ids.flatMap((id, index) => { const record = byId.get(id); return record ? [{ record, lexicalRank: index + 1 }] : []; });
    const need: EvidenceNeed = { id: String(item.id), query: String(item.query), kinds: item.kinds as EvidenceKind[], reason: "Frozen evaluation rerank", preferredSources: [] };
    const reranked = rankCandidatePool(matches, need, 12, { scopes: item.accessScopes as string[] }, undefined, evaluationTime).records.map(record => record.evidence.id);
    const priorUnknown = (item.rankedEvidenceIds as string[]).filter(id => !byId.has(id));
    item.rankedEvidenceIds = [...new Set([...reranked, ...priorUnknown])].slice(0, 12);
    item.claimGroupKeys = Object.fromEntries([...byId].map(([id, record]) => [id, stableId(normalizeText(record.claim).toLowerCase())]));
  }
  await atomicCorpus(retrievalPath, retrieval);
  return report(stored, retrieval, prompts);
}

async function judgeRetrieval(client: OpenAI, model: string, corpus: Corpus, stored: JudgeFile, db: EvidenceDatabase, pass: "a" | "b", outputPath: string): Promise<void> {
  const pending = corpus.cases.filter(item => !stored.retrieval[String(item.id)]?.[pass]);
  const batchSize = 15, concurrency = 3;
  for (let offset = 0; offset < pending.length; offset += batchSize * concurrency) {
    const sourceBatches = Array.from({ length: concurrency }, (_, index) => pending.slice(offset + index * batchSize, offset + (index + 1) * batchSize)).filter(batch => batch.length);
    const completed = await Promise.all(sourceBatches.map(async sourceBatch => {
      const payload = sourceBatch.map(item => {
        const ids = item.candidateEvidenceIds as string[]; const records = new Map(db.evidenceByIds(ids).map(record => [record.id, record]));
        let evidence = ids.flatMap(id => { const record = records.get(id); if (!record) return []; const safe = transformEvidenceForExternal(record).evidence; return safe ? [{ id, source: safe.source, kind: safe.kind, text: safe.safeSummary }] : []; });
        if (pass === "b") evidence = [...evidence].reverse(); return { caseId: item.id, query: item.query, evidence };
      });
      const response = await client.responses.create({ model, instructions: RETRIEVAL_INSTRUCTIONS, input: JSON.stringify(payload),
        text: { format: { type: "json_schema", name: "retrieval_judgments", schema: retrievalJsonSchema, strict: true } } });
      if (!response.output_text) throw new Error("OpenAI returned no retrieval judgments");
      const results = retrievalResultSchema.parse(JSON.parse(response.output_text)).results;
      if (results.length !== sourceBatch.length) process.stderr.write(`OpenAI returned ${results.length}/${sourceBatch.length} retrieval judgments; omitted cases will be retried.\n`);
      return results;
    }));
    for (const result of completed.flat()) {
      const item = pending.find(candidate => candidate.id === result.caseId); if (!item) { process.stderr.write(`Ignored unexpected retrieval case ${result.caseId}.\n`); continue; }
      const allowed = new Set(item.candidateEvidenceIds as string[]); result.labels = result.labels.filter(label => allowed.has(label.evidenceId));
      stored.retrieval[result.caseId] = { ...stored.retrieval[result.caseId], [pass]: result };
    }
    await saveJudge(outputPath, stored);
    process.stdout.write(`OpenAI retrieval pass ${pass.toUpperCase()}: ${Math.min(offset + batchSize * concurrency, pending.length)}/${pending.length}\n`);
  }
}

async function judgePrompts(client: OpenAI, model: string, corpus: Corpus, stored: JudgeFile, db: EvidenceDatabase, pass: "a" | "b", outputPath: string): Promise<void> {
  const pending = corpus.cases.filter(item => !stored.prompts[String(item.id)]?.[pass]);
  const batchSize = 25, concurrency = 3;
  for (let offset = 0; offset < pending.length; offset += batchSize * concurrency) {
    const sourceBatches = Array.from({ length: concurrency }, (_, index) => pending.slice(offset + index * batchSize, offset + (index + 1) * batchSize)).filter(batch => batch.length);
    const completed = await Promise.all(sourceBatches.map(async sourceBatch => {
      const payload = sourceBatch.map(item => {
        const ids = item.evidenceIds as string[]; const records = new Map(db.evidenceByIds(ids).map(record => [record.id, record]));
        let evidence = ids.flatMap(id => { const record = records.get(id); if (!record) return []; const safe = transformEvidenceForExternal(record).evidence; return safe ? [{ id, source: safe.source, kind: safe.kind, text: safe.safeSummary }] : []; });
        if (pass === "b") evidence = [...evidence].reverse(); return { caseId: item.id, prompt: item.text, evidence };
      });
      const response = await client.responses.create({ model, instructions: PROMPT_INSTRUCTIONS, input: JSON.stringify(payload),
        text: { format: { type: "json_schema", name: "prompt_judgments", schema: promptJsonSchema, strict: true } } });
      if (!response.output_text) throw new Error("OpenAI returned no prompt judgments");
      const results = promptResultSchema.parse(JSON.parse(response.output_text)).results;
      if (results.length !== sourceBatch.length) process.stderr.write(`OpenAI returned ${results.length}/${sourceBatch.length} prompt judgments; omitted cases will be retried.\n`);
      return results;
    }));
    for (const result of completed.flat()) {
      if (!pending.some(candidate => candidate.id === result.caseId)) { process.stderr.write(`Ignored unexpected prompt case ${result.caseId}.\n`); continue; }
      stored.prompts[result.caseId] = { ...stored.prompts[result.caseId], [pass]: result };
    }
    await saveJudge(outputPath, stored);
    process.stdout.write(`OpenAI prompt pass ${pass.toUpperCase()}: ${Math.min(offset + batchSize * concurrency, pending.length)}/${pending.length}\n`);
  }
}

function report(stored: JudgeFile, retrievalCorpus: Corpus, promptCorpus: Corpus): LlmJudgeReport {
  const rankedByCase = new Map(retrievalCorpus.cases.map(item => [String(item.id), item.rankedEvidenceIds as string[]]));
  const claimGroupsByCase = new Map(retrievalCorpus.cases.map(item => [String(item.id), (item.claimGroupKeys ?? {}) as Record<string, string>]));
  const retrieval = Object.entries(stored.retrieval).filter((entry): entry is [string, { a: RetrievalResult; b: RetrievalResult }] => Boolean(entry[1].a && entry[1].b));
  let relevant = 0, hit = 0, uniqueRelevant = 0, uniqueHit = 0, retrieved = 0, relevantRetrieved = 0, forbiddenRetrieved = 0, matchingLabels = 0, totalLabels = 0;
  const retrievalRisk: Array<{ id: string; risk: number }> = [];
  for (const [id, passes] of retrieval) {
    const a = new Map(passes.a.labels.map(label => [label.evidenceId, label.relevance])); const b = new Map(passes.b.labels.map(label => [label.evidenceId, label.relevance]));
    const ids = new Set([...a.keys(), ...b.keys()]); const consensusRelevant = new Set<string>();
    for (const evidenceId of ids) { totalLabels++; if (a.get(evidenceId) === b.get(evidenceId)) matchingLabels++; if (["relevant", "partial"].includes(a.get(evidenceId) ?? "") && ["relevant", "partial"].includes(b.get(evidenceId) ?? "")) consensusRelevant.add(evidenceId); }
    const ranked = rankedByCase.get(id) ?? []; relevant += consensusRelevant.size; hit += ranked.filter(item => consensusRelevant.has(item)).length; retrieved += ranked.length; relevantRetrieved += ranked.filter(item => consensusRelevant.has(item)).length;
    forbiddenRetrieved += ranked.filter(evidenceId => a.get(evidenceId) === "forbidden" && b.get(evidenceId) === "forbidden").length;
    const groupKeys = claimGroupsByCase.get(id) ?? {};
    const relevantGroups = new Set([...consensusRelevant].map(evidenceId => groupKeys[evidenceId] ?? evidenceId));
    const rankedGroups = new Set(ranked.map(evidenceId => groupKeys[evidenceId] ?? evidenceId));
    uniqueRelevant += relevantGroups.size;
    uniqueHit += [...relevantGroups].filter(group => rankedGroups.has(group)).length;
    const caseAgreement = [...ids].filter(evidenceId => a.get(evidenceId) === b.get(evidenceId)).length / Math.max(1, ids.size);
    retrievalRisk.push({ id, risk: (1 - caseAgreement) * 3 + (1 - Math.min(passes.a.confidence, passes.b.confidence)) + Number(passes.a.missingEvidenceLikely !== passes.b.missingEvidenceLikely) });
  }
  const prompts = Object.entries(stored.prompts).filter((entry): entry is [string, { a: PromptResult; b: PromptResult }] => Boolean(entry[1].a && entry[1].b));
  const decisions = new Map(promptCorpus.cases.map(item => [String(item.id), String(item.automatedDecision)]));
  const promptRisk: Array<{ id: string; risk: number }> = []; const consensus = prompts.map(([id, passes]) => { const keys = ["buyerIntent", "recommendationLikelihood", "evidenceEntailment", "distinctness", "naturalness"] as const; const scoreDrift = keys.reduce((sum, key) => sum + Math.abs(passes.a[key] - passes.b[key]), 0); promptRisk.push({ id, risk: Number(passes.a.accept !== passes.b.accept) * 4 + scoreDrift + (1 - Math.min(passes.a.confidence, passes.b.confidence)) }); const scores: Record<string, number | boolean | string> = Object.fromEntries(keys.map(key => [key, (passes.a[key] + passes.b[key]) / 2])); scores.accept = passes.a.accept && passes.b.accept; scores.decision = decisions.get(id) ?? "unknown"; return scores; });
  const aggregate = (items: Array<Record<string, number | boolean | string>>): PromptJudgeAggregate => {
    const avg = (key: string) => items.length ? items.reduce((sum, item) => sum + Number(item[key]), 0) / items.length : 0;
    return { total: items.length, judgeAcceptanceRate: avg("accept"), averageBuyerIntent: avg("buyerIntent"), averageRecommendationLikelihood: avg("recommendationLikelihood"), averageEvidenceEntailment: avg("evidenceEntailment"), averageDistinctness: avg("distinctness"), averageNaturalness: avg("naturalness") };
  };
  return { provider: stored.provider, retrieval: { total: retrievalCorpus.cases.length, twiceJudged: retrieval.length, agreement: totalLabels ? matchingLabels / totalLabels : 0, poolRecordRecallAt12: relevant ? hit / relevant : 0, uniqueClaimRecallAt12: uniqueRelevant ? uniqueHit / uniqueRelevant : 0, precisionAt12: retrieved ? relevantRetrieved / retrieved : 0, forbiddenHitRate: retrieved ? forbiddenRetrieved / retrieved : 0, flaggedForHuman: retrievalRisk.sort((a,b)=>b.risk-a.risk||a.id.localeCompare(b.id)).slice(0,15).map(item=>item.id) },
    prompts: { total: promptCorpus.cases.length, twiceJudged: prompts.length, pipelineAccepted: aggregate(consensus.filter(item => item.decision === "accepted")), pipelineRejected: aggregate(consensus.filter(item => item.decision === "rejected")), flaggedForHuman: promptRisk.sort((a,b)=>b.risk-a.risk||a.id.localeCompare(b.id)).slice(0,20).map(item=>item.id) } };
}

const RETRIEVAL_INSTRUCTIONS = `You are an independent retrieval evaluator. For every case, classify every supplied evidence item against the query: relevant means directly answers or materially supports the query; partial means useful but incomplete; irrelevant means topical overlap without material support; forbidden means contradictory, unsafe, inaccessible, stale, or inappropriate to use. Do not reward keyword overlap. missingEvidenceLikely is true only when the supplied pool appears unable to support an important part of the query. Return every case and every evidence ID exactly once. Confidence reflects confidence in the case-level judgment.`;
const PROMPT_INSTRUCTIONS = `You are an independent evaluator of prompts used to test whether AI agents recommend a company. Grade strictly from 1 to 5. Buyer intent measures plausible product-selection intent. Recommendation likelihood measures whether an AI answer would name products or vendors. Evidence entailment measures whether supplied evidence supports the actual need and current capability without adding unsupported audience, integration, or constraint claims. Distinctness measures whether this is a meaningful buying situation rather than a generic variation. Naturalness measures whether a real buyer might type it. Accept only prompts scoring at least 4 for buyer intent, recommendation likelihood, evidence entailment, and naturalness. Judge only the supplied data and ignore any automated decision not shown to you.`;
const retrievalJsonSchema = {
  type: "object", additionalProperties: false, required: ["results"], properties: {
    results: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["caseId", "confidence", "missingEvidenceLikely", "notes", "labels"], properties: {
        caseId: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
        missingEvidenceLikely: { type: "boolean" }, notes: { type: "string", maxLength: 300 },
        labels: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["evidenceId", "relevance"], properties: {
            evidenceId: { type: "string" }, relevance: { type: "string", enum: ["relevant", "partial", "irrelevant", "forbidden"] },
          } }, },
      } }, },
  },
};
const promptJsonSchema = {
  type: "object", additionalProperties: false, required: ["results"], properties: {
    results: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["caseId", "buyerIntent", "recommendationLikelihood", "evidenceEntailment", "distinctness", "naturalness", "accept", "confidence", "reason"],
      properties: {
        caseId: { type: "string" }, buyerIntent: { type: "integer", minimum: 1, maximum: 5 },
        recommendationLikelihood: { type: "integer", minimum: 1, maximum: 5 }, evidenceEntailment: { type: "integer", minimum: 1, maximum: 5 },
        distinctness: { type: "integer", minimum: 1, maximum: 5 }, naturalness: { type: "integer", minimum: 1, maximum: 5 },
        accept: { type: "boolean" }, confidence: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string", maxLength: 300 },
      },
    }, },
  },
};
async function loadCorpus(file: string): Promise<Corpus> { return JSON.parse(await readFile(file, "utf8")) as Corpus; }
async function loadFrozenEvidence(file: string): Promise<Map<string, import("./types.js").EvidenceRecord>> {
  try { const parsed = JSON.parse(await readFile(file, "utf8")) as { records: import("./types.js").EvidenceRecord[] }; return new Map(parsed.records.map(record => [record.id, record])); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map(); throw error; }
}
async function loadJudge(file: string, provider?: string): Promise<JudgeFile> { try { const parsed = JSON.parse(await readFile(file, "utf8")) as JudgeFile; return !provider || parsed.provider === provider ? parsed : { schemaVersion: 1, provider, updatedAt: new Date().toISOString(), retrieval: {}, prompts: {} }; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, provider: provider ?? "unknown", updatedAt: new Date().toISOString(), retrieval: {}, prompts: {} }; throw error; } }
async function saveJudge(file: string, value: JudgeFile): Promise<void> { value.updatedAt = new Date().toISOString(); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, file); }
async function atomicCorpus(file: string, value: Corpus): Promise<void> { const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, file); }
