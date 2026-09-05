import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { AppConfig } from "./config.js";
import { companyById } from "./config.js";
import { runCompany } from "./pipeline/run.js";
import { EvidenceDatabase } from "./store/database.js";
import { PostgresMetadataStore } from "./store/postgres-metadata.js";
import type { CompanyConfig, EvidenceRecord, FeedbackReason, RunResult, SourceArtifact } from "./types.js";
import { log, normalizeText } from "./util.js";
import { operationalMetrics } from "./operations/metrics.js";
import { redactedEvidenceExcerptForUi, safePreviewForUi } from "./privacy/transform.js";
import { composeTrackingSet } from "./prompts/tracking-set.js";
import { isScheduledMinute, runDueCompanies } from "./scheduler.js";

let processing = false;
let scheduling = false;

export async function serve(config: AppConfig, fixtures: boolean): Promise<void> {
  if (!isExternalServingAllowed(config.host, config.accessPassword, config.allowPublicAccess)) {
    throw new Error("Set PROMPTGEN_ACCESS_PASSWORD or explicitly enable PROMPTGEN_ALLOW_PUBLIC_ACCESS when serving on a non-loopback host");
  }
  const hosted = config.postgresUrl ? new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName) : undefined;
  const server = createServer(async (request, response) => {
    const started = performance.now();
    try {
      if (!isPublicProbe(request) && config.accessPassword && !isAuthorizationValid(request.headers.authorization, config.accessPassword)) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="Manicule Promptgen", charset="UTF-8"', "cache-control": "no-store" });
        response.end("Authentication required"); return;
      }
      await route(config, fixtures, hosted, request, response);
    }
    catch (error) { json(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
    finally {
      operationalMetrics.increment("promptgen_http_requests_total", { method: request.method ?? "UNKNOWN", status: String(response.statusCode) });
      operationalMetrics.observe("promptgen_http_request_duration_seconds", (performance.now() - started) / 1000,
        { method: request.method ?? "UNKNOWN", status: String(response.statusCode) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  void processJobs(config, hosted);
  const queueTick = setInterval(() => void processJobs(config, hosted), 5_000);
  queueTick.unref();
  const schedulerOwner = `${process.pid}:${randomUUID()}`;
  const schedulerTick = config.schedulerEnabled ? setInterval(() => {
    const now = new Date();
    if (scheduling || !isScheduledMinute(now, config.dailyAt, config.timezone)) return;
    scheduling = true;
    void runDueCompanies(config, fixtures, schedulerOwner, now)
      .catch(error => log("error", "scheduler.run-failed", { error: errorMessage(error) }))
      .finally(() => { scheduling = false; });
  }, 30_000) : undefined;
  schedulerTick?.unref();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true; clearInterval(queueTick); if (schedulerTick) clearInterval(schedulerTick);
    await new Promise<void>(resolve => server.close(() => resolve()));
    while (processing) await new Promise(resolve => setTimeout(resolve, 100));
    await hosted?.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  log("info", "server.started", { url: `http://${config.host}:${config.port}`, fixtures, schedulerEnabled: config.schedulerEnabled,
    access: config.accessPassword ? "password-protected" : config.allowPublicAccess ? "public" : "loopback-only" });
}

export function isExternalServingAllowed(host: string, accessPassword: string | undefined, allowPublicAccess: boolean): boolean {
  return isLoopback(host) || Boolean(accessPassword) || allowPublicAccess;
}

export function isAuthorizationValid(header: string | undefined, expectedPassword: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const supplied = Buffer.from(decoded.slice(separator + 1));
  const expected = Buffer.from(expectedPassword);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isPublicProbe(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  return pathname === "/healthz" || pathname === "/readyz";
}

function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }

async function route(config: AppConfig, fixtures: boolean, hosted: PostgresMetadataStore | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { status: "alive", uptimeSeconds: Math.floor(process.uptime()) }); return;
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    const readiness = await checkReadiness(config, hosted);
    json(response, readiness.ready ? 200 : 503, readiness); return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    response.end(operationalMetrics.render()); return;
  }
  if (request.method === "POST" && request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
    json(response, 403, { error: "Cross-origin mutation denied" }); return;
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    using db = new EvidenceDatabase(config.dbPath);
    json(response, 200, { companies: config.companies, runs: await Promise.all(db.latestResults().map(result => presentRun(db, result, hosted))), active: hosted ? await hosted.activeJobCompanyIds() : db.activeJobCompanyIds() }); return;
  }
  const traceMatch = url.pathname.match(/^\/api\/runs\/([A-Za-z0-9-]+)\/trace$/);
  if (request.method === "GET" && traceMatch?.[1]) {
    using db = new EvidenceDatabase(config.dbPath);
    const events = db.traceForRun(traceMatch[1]);
    if (events.length === 0) { json(response, 404, { error: "Trace not found" }); return; }
    const stages: Record<string, number> = {}, actions: Record<string, number> = {}, rejectionReasons: Record<string, number> = {};
    const reconciliation: Record<string, number> = {};
    const privacy: Array<Record<string, unknown>> = [];
    for (const event of events) {
      stages[event.stage] = (stages[event.stage] ?? 0) + 1; actions[event.action] = (actions[event.action] ?? 0) + 1;
      if (event.action === "rejected" && Array.isArray(event.data.findings)) for (const finding of event.data.findings) {
        if (finding && typeof finding === "object" && "code" in finding) { const code = String(finding.code); rejectionReasons[code] = (rejectionReasons[code] ?? 0) + 1; }
      }
      if (Array.isArray(event.data.reconciliation)) for (const decision of event.data.reconciliation) {
        if (decision && typeof decision === "object" && "action" in decision) {
          const action = String(decision.action); reconciliation[action] = (reconciliation[action] ?? 0) + 1;
        }
      }
      if (event.stage === "privacy" && Array.isArray(event.data.transformations)) privacy.push(...event.data.transformations.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>);
    }
    const durationMs = Date.parse(events.at(-1)!.at) - Date.parse(events[0]!.at);
    json(response, 200, { runId: traceMatch[1], totalEvents: events.length, stages, actions,
      durationMs, reconciliation, privacyTransformations: privacy.slice(0, 200),
      rejectionReasons: Object.entries(rejectionReasons).sort((a,b)=>b[1]-a[1]).slice(0,10),
      sourceFailures: events.filter(event => event.action === "source-failed").map(event => event.data.source) }); return;
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/);
  if (request.method === "GET" && jobMatch?.[1]) {
    using db = new EvidenceDatabase(config.dbPath);
    const job = hosted ? await hosted.jobById(jobMatch[1]) : db.jobById(jobMatch[1]);
    if (!job) { json(response, 404, { error: "Job not found" }); return; }
    json(response, 200, { ...job, ...(job.result ? { result: await presentRun(db, job.result, hosted) } : {}) }); return;
  }
  const cancelMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch?.[1]) {
    using db = new EvidenceDatabase(config.dbPath);
    const accepted = hosted ? await hosted.requestJobCancellation(cancelMatch[1]) : db.requestJobCancellation(cancelMatch[1]);
    json(response, accepted ? 202 : 409, { jobId: cancelMatch[1], cancellationRequested: accepted }); return;
  }
  const feedbackMatch = url.pathname.match(/^\/api\/prompts\/([a-z0-9-]+)\/([a-z0-9-]+)\/feedback$/);
  if (request.method === "POST" && feedbackMatch?.[1] && feedbackMatch[2]) {
    if (!hosted) { json(response, 503, { error: "Hosted metadata is not configured" }); return; }
    const body = await readJson(request); const verdict = body.verdict;
    if (verdict !== "approved" && verdict !== "rejected" && verdict !== "edited") { json(response, 400, { error: "Invalid verdict" }); return; }
    let editedText: string | undefined;
    if (typeof body.editedText === "string") {
      try { editedText = validateCustomerPrompt(body.editedText); }
      catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
    }
    const notes = typeof body.notes === "string" ? body.notes.slice(0, 2_000) : undefined;
    const reasons: FeedbackReason[] = ["wrong-audience","unsupported-capability","too-niche","already-covered","not-buying-intent","other"];
    const reason = typeof body.reason === "string" && reasons.includes(body.reason as FeedbackReason) ? body.reason as FeedbackReason : undefined;
    const ruleScope = body.ruleScope === "set" ? "set" : "prompt";
    await hosted.recordPromptFeedback(feedbackMatch[1], feedbackMatch[2], verdict, editedText, notes, reason, ruleScope);
    json(response, 201, { recorded: true }); return;
  }
  const manualPromptMatch = url.pathname.match(/^\/api\/companies\/([a-z0-9-]+)\/prompts$/);
  if (request.method === "POST" && manualPromptMatch?.[1]) {
    if (!hosted) { json(response, 503, { error: "Hosted metadata is not configured" }); return; }
    const body = await readJson(request);
    if (typeof body.text !== "string") { json(response, 400, { error: "Prompt text is required" }); return; }
    let text: string;
    try { text = validateCustomerPrompt(body.text); }
    catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
    const promptId = await hosted.addManualPrompt(manualPromptMatch[1], text);
    json(response, 201, { recorded: true, promptId }); return;
  }
  const observationMatch = url.pathname.match(/^\/api\/prompts\/([a-z0-9-]+)\/([a-z0-9-]+)\/observations$/);
  if (request.method === "POST" && observationMatch?.[1] && observationMatch[2]) {
    if (!hosted) { json(response, 503, { error: "Hosted metadata is not configured" }); return; }
    const body = await readJson(request);
    if (typeof body.agent !== "string" || typeof body.companyMentioned !== "boolean") { json(response, 400, { error: "agent and companyMentioned are required" }); return; }
    await hosted.recordAgentObservation({ companyKey: observationMatch[1], promptKey: observationMatch[2], agent: body.agent.slice(0, 80),
      evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : new Date().toISOString(), companyMentioned: body.companyMentioned,
      citedUrls: stringArray(body.citedUrls, 100), competitors: stringArray(body.competitors, 100),
      ...(typeof body.answerHash === "string" ? { answerHash: body.answerHash.slice(0, 128) } : {}) });
    json(response, 201, { recorded: true }); return;
  }
  const runMatch = url.pathname.match(/^\/api\/run\/([a-z0-9.-]+)$/);
  if (request.method === "POST" && runMatch?.[1]) {
    const company = companyById(config, runMatch[1]);
    using db = new EvidenceDatabase(config.dbPath);
    const input = { id: randomUUID(), company, fixtures, createdAt: new Date().toISOString() };
    const job = hosted ? await hosted.enqueueJob(input) : db.enqueueJob(input);
    void processJobs(config, hosted);
    json(response, 202, { jobId: job.id, companyId: job.companyId, status: job.status }); return;
  }
  if (request.method === "POST" && url.pathname === "/api/run-domain") {
    const body = await readJson(request);
    const domain = normalizeDomain(body.domain);
    const configured = config.companies.find(item => item.domain === domain || `www.${item.domain}` === domain || item.domain === domain.replace(/^www\./, ""));
    const company = configured ?? publicCompany(domain);
    using db = new EvidenceDatabase(config.dbPath);
    const input = { id: randomUUID(), company, fixtures: Boolean(configured) && fixtures, createdAt: new Date().toISOString() };
    const job = hosted ? await hosted.enqueueJob(input) : db.enqueueJob(input);
    void processJobs(config, hosted);
    json(response, 202, { jobId: job.id, companyId: job.companyId, status: job.status }); return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/prompts")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); return;
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(clientJs); return;
  }
  json(response, 404, { error: "Not found" });
}

async function processJobs(config: AppConfig, hosted?: PostgresMetadataStore): Promise<void> {
  if (processing) return;
  processing = true;
  const owner = `${process.pid}:${randomUUID()}`;
  try {
    for (;;) {
      let job;
      {
        using db = new EvidenceDatabase(config.dbPath);
        job = hosted ? await hosted.claimJob(owner, new Date(), 120_000) : db.claimJob(owner, new Date(), 120_000);
      }
      if (!job) break;
      const controller = new AbortController();
      const renew = setInterval(() => {
        using db = new EvidenceDatabase(config.dbPath);
        if (hosted) void hosted.renewJobLease(job.id, owner, new Date(), 120_000).catch(error => log("error", "job.lease-renewal-failed", { jobId: job.id, error: errorMessage(error) }));
        else db.renewJobLease(job.id, owner, new Date(), 120_000);
      }, 30_000);
      renew.unref();
      const cancellation = setInterval(() => {
        using db = new EvidenceDatabase(config.dbPath);
        if (hosted) void hosted.isCancellationRequested(job.id).then(cancelled => { if (cancelled) controller.abort(new Error("Job cancellation requested")); })
          .catch(error => log("error", "job.cancellation-check-failed", { jobId: job.id, error: errorMessage(error) }));
        else if (db.isCancellationRequested(job.id)) controller.abort(new Error("Job cancellation requested"));
      }, 1_000);
      cancellation.unref();
      try {
        const result = await runCompany(config, job.company, { fixtures: job.fixtures, signal: controller.signal });
        using db = new EvidenceDatabase(config.dbPath);
        if (hosted) await hosted.finishJob(job.id, owner, result);
        else db.finishJob(job.id, owner, result);
      } finally {
        clearInterval(renew);
        clearInterval(cancellation);
      }
    }
  } finally {
    processing = false;
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function stringArray(value: unknown, limit: number): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : []; }

async function checkReadiness(config: AppConfig, hosted?: PostgresMetadataStore): Promise<{ ready: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  try { using db = new EvidenceDatabase(config.dbPath); db.latestResults(); checks.localStore = "ready"; }
  catch { checks.localStore = "unavailable"; }
  if (hosted) {
    try { await withDeadline(hosted.health(), 5_000); checks.postgres = "ready"; }
    catch { checks.postgres = "unavailable"; }
  } else checks.postgres = "not-configured";
  if (config.embeddingProvider === "disabled") checks.embeddings = "disabled";
  else {
    try {
      let response = await fetch(new URL("/api/tags", config.ollamaUrl), { signal: AbortSignal.timeout(2_000) });
      if (response.status === 404) response = await fetch(new URL("/health", config.ollamaUrl), { signal: AbortSignal.timeout(2_000) });
      checks.embeddings = response.ok ? "ready" : "unavailable";
    } catch { checks.embeddings = "unavailable"; }
  }
  const modelReady = config.modelProvider === "local" ||
    (config.modelProvider === "anthropic" && Boolean(config.anthropicApiKey)) ||
    (config.modelProvider === "openai" && Boolean(config.openaiApiKey)) ||
    (config.modelProvider === "auto" && Boolean(config.anthropicApiKey || config.openaiApiKey));
  checks.promptModel = modelReady ? "ready" : "unavailable";
  return { ready: checks.localStore === "ready" && checks.postgres !== "unavailable" && checks.promptModel === "ready", checks };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Readiness timeout")), timeoutMs))]);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length; if (size > 4_096) throw new Error("Request body is too large"); chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== "string" || value.length > 253) throw new Error("Enter a valid company domain");
  let hostname: string;
  try { hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { throw new Error("Enter a valid company domain"); }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname) || hostname.includes("..") || isIP(hostname) || hostname === "localhost") throw new Error("Enter a public company domain");
  return hostname;
}

function publicCompany(domain: string): CompanyConfig {
  const bare = domain.replace(/^www\./, "");
  const label = bare.split(".")[0] ?? bare;
  return {
    id: `domain-${bare.replaceAll(/[^a-z0-9]+/g, "-")}`,
    name: label.charAt(0).toUpperCase() + label.slice(1), domain: bare,
    category: "company or product", githubOrganizations: [], enabledSources: ["web"],
  };
}

async function presentRun(db: EvidenceDatabase, result: RunResult, hosted?: PostgresMetadataStore): Promise<RunResult & { evidence: Record<string, PresentedEvidence>; sourceHealth: ReturnType<EvidenceDatabase["sourceHealth"]> }> {
  const [benchmarkPrompts, promptStates] = hosted ? await Promise.all([hosted.benchmarkPrompts(result.companyId), hosted.promptStates(result.companyId)]) : [[], []];
  const states = new Map(promptStates.map(prompt => [prompt.stableKey, prompt]));
  const benchmarkKeys = new Set(benchmarkPrompts.flatMap(prompt => [prompt.id, prompt.semanticKey].filter((item): item is string => Boolean(item))));
  const activeDiscovery = result.discoveryPrompts.filter(prompt => states.get(prompt.id)?.active !== false).map(prompt => ({ ...prompt,
    text: states.get(prompt.id)?.text ?? prompt.text,
    origin: prompt.origin ?? "inferred-opportunity" as const,
    coverage: prompt.coverage ?? { audience: "general buyer", useCase: prompt.semanticKey?.replaceAll("-", " ") ?? prompt.archetype,
      constraint: prompt.archetype === "constraint" ? "stated constraint" : "none stated", decisionStage: "evaluation" as const },
    set: benchmarkKeys.has(prompt.id) || Boolean(prompt.semanticKey && benchmarkKeys.has(prompt.semanticKey)) ? "benchmark" as const : "discovery" as const }));
  const trackingSet = composeTrackingSet(activeDiscovery, benchmarkPrompts, 10);
  const discoveryPrompts = trackingSet.discovery;
  const presentedBenchmarks = trackingSet.benchmarks;
  const ids = [...discoveryPrompts, ...presentedBenchmarks].flatMap(prompt => prompt.evidenceIds);
  const records = db.evidenceByIds(ids);
  const artifacts = new Map(db.artifactsByIds(records.map(record => record.artifactId)).map(artifact => [artifact.id, artifact]));
  const evidence = Object.fromEntries(records.map(record => [record.id, presentEvidence(record, artifacts.get(record.artifactId))]));
  return { ...result, discoveryPrompts, benchmarkPrompts: presentedBenchmarks, evidence, sourceHealth: db.sourceHealth(result.companyId) };
}

function validateCustomerPrompt(input: string): string {
  const text = normalizeText(input);
  if (text.length < 12 || text.length > 220) throw new Error("Prompt must be between 12 and 220 characters");
  if (!text.endsWith("?")) throw new Error("Prompt must be written as a question ending in ?");
  return text;
}

interface PresentedEvidence { id: string; artifactId: string; source: string; kind: string; visibility: string; occurredAt: string; safeUse: string; summary: string; externalModelSummary: string; buyerIntent?: string; sourceTitle?: string; sourceLocator: string; sourceLine?: number; sourceUrl?: string; privacyRules: string[] }
function presentEvidence(record: EvidenceRecord, artifact?: SourceArtifact): PresentedEvidence {
  const transformed = safePreviewForUi(record);
  const excerpt = redactedEvidenceExcerptForUi(record);
  const summary = excerpt.text;
  const sourceUrl = safeSourceUrl(artifact?.url);
  const sourceLine = evidenceLine(artifact?.content, record.quote, record.claim);
  return { id: record.id, artifactId: record.artifactId, source: record.source, kind: record.kind, visibility: record.visibility, occurredAt: record.occurredAt,
    safeUse: record.safeUse, summary, ...(record.buyerIntent ? { buyerIntent: record.buyerIntent } : {}),
    ...(artifact?.title ? { sourceTitle: artifact.title } : {}), sourceLocator: `${record.source}:${artifact?.externalId ?? record.artifactId}`,
    ...(sourceLine ? { sourceLine } : {}), ...(sourceUrl ? { sourceUrl } : {}), externalModelSummary: transformed.text, privacyRules: [...new Set([...excerpt.rules, ...transformed.rules])] };
}
function evidenceLine(content?: string, ...needles: Array<string | undefined>): number | undefined {
  if (!content || !content.includes("\n")) return undefined;
  for (const needle of needles) {
    const value = needle?.trim();
    if (!value) continue;
    const index = content.toLowerCase().indexOf(value.toLowerCase());
    if (index >= 0) return content.slice(0, index).split("\n").length;
  }
  return undefined;
}
function safeSourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined; }
  catch { return undefined; }
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manicule Prompt Discovery</title><style>
@font-face{font-family:ManiculeDisplay;src:url(https://manicule.com/_next/static/immutable/media/NeueHaasDisplayRoman-s.p.1mel1to8o_o6y.woff) format('woff');font-weight:400;font-display:swap}@font-face{font-family:ManiculeDisplay;src:url(https://manicule.com/_next/static/immutable/media/NeueHaasDisplayBold-s.p.22sbuoebnd19b.woff) format('woff');font-weight:700;font-display:swap}@font-face{font-family:ManiculeMono;src:url(https://manicule.com/_next/static/immutable/media/GeistMono_Variable-s.p.29-evb1axjc7u.ttf) format('truetype');font-display:swap}
:root:root{--ink:#f7f7f4;--muted:#a7a39a;--soft:#77746c;--line:#f7f7f42e;--wash:#14120b;--teal:#f9452d;--teal-dark:#f9452d;--blue:#f9452d;--green:#f7f7f4;--amber:#edb200;color-scheme:dark}html body{background:#14120b;color:#f7f7f4;font-family:ManiculeMono,ui-monospace,SFMono-Regular,Menlo,monospace}body .shell{width:min(1600px,100%);min-height:100vh;margin:0 auto;background:#14120b;border:0}body .hero{position:relative;min-height:100vh;padding:150px 24px 80px;background-color:#14120b;background-image:linear-gradient(90deg,#ffffff0d 1px,transparent 1px),linear-gradient(#ffffff0d 1px,transparent 1px);background-size:40px 40px;display:flex;flex-direction:column;justify-content:center}body .hero:before{content:'MANICULE';position:absolute;inset:0 0 auto;height:57px;display:flex;align-items:center;padding-left:58px;border-bottom:1px solid #f7f7f433;background-color:#14120bcc;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 599 492' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M343.173 250.99V491.083L171.586 396.515L0 491.083V248.544L171.586 147.91L343.173 250.99Z' fill='%23F7F7F4'/%3E%3Cpath d='M598.851 296.393L387.448 418.465L387.456 225.447L215.862 121.269L425.906 0L598.851 98.281V296.393Z' fill='%23F7F7F4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:24px center;background-size:24px 20px;color:#f7f7f4;font-family:ManiculeDisplay,Arial,sans-serif;font-weight:700;letter-spacing:-.03em;text-align:left}body .hero .eyebrow{font-size:0;color:#f9452d}body .hero .eyebrow:after{content:'[ AGENTREL: PROMPT DISCOVERY ]';font:12px ManiculeMono,monospace;letter-spacing:.14em}body .hero h1{max-width:900px;margin:24px auto 24px;color:#f7f7f4;font-family:ManiculeDisplay,Arial,sans-serif;font-size:clamp(44px,6.7vw,88px);font-weight:700;line-height:.94;letter-spacing:-.045em;text-transform:uppercase}body .lede{max-width:720px;color:#a7a39a;font-family:ManiculeDisplay,Arial,sans-serif;font-size:20px;line-height:1.55}body .domain-form{max-width:800px;margin-top:40px}body .domain-form input{border:1px solid #f7f7f466;border-right:0;background:#14120b;color:#f7f7f4;border-radius:0;padding:18px;font-family:ManiculeMono,monospace}body .domain-form input::placeholder{color:#77746c}body .domain-form input:focus{box-shadow:inset 0 0 0 1px #f9452d;border-color:#f9452d}body .primary{background:#f7f7f4;color:#14120b;border-radius:0;text-transform:uppercase;letter-spacing:.08em}body .primary:hover{background:#f9452d;color:#14120b}body .recorded,body .note{color:#77746c;text-transform:uppercase;font-size:11px;letter-spacing:.08em}body .domain-chip{border:1px solid #f7f7f433;background:#14120b;color:#f7f7f4;border-radius:0}body .domain-chip:hover{border-color:#f9452d;color:#f9452d}body .progress{min-height:100vh;padding-top:30vh;background-color:#14120b;background-image:linear-gradient(90deg,#ffffff0d 1px,transparent 1px),linear-gradient(#ffffff0d 1px,transparent 1px);background-size:40px 40px}body .progress h2{font-family:ManiculeDisplay,Arial,sans-serif;text-transform:uppercase}body .step{border-color:#f7f7f433;border-radius:0;background:#14120b;color:#a7a39a;text-transform:uppercase;font-size:11px;letter-spacing:.08em}body .results{background:#14120b;color:#f7f7f4}body .result-head h2{color:#f7f7f4;font-family:ManiculeDisplay,Arial,sans-serif;font-size:42px;text-transform:uppercase}body .eyebrow{color:#f9452d;font-family:ManiculeMono,monospace}body .meta{color:#a7a39a}body .pill{border:1px solid #f7f7f466;border-radius:999px;background:transparent;color:#f7f7f4}body .refresh,body .evidence-toggle{border:1px solid #f7f7f466;border-radius:0;background:#14120b;color:#f7f7f4;text-transform:uppercase;font-size:11px;letter-spacing:.06em}body .refresh:hover,body .evidence-toggle:hover{border-color:#f9452d;color:#f9452d}body .add-prompt{background:#f7f7f4!important;color:#14120b!important;border-color:#f7f7f4!important}body .empty,body .prompt{border:1px solid #f7f7f433;border-radius:0;background:#14120b;color:#a7a39a}body .prompt:hover{background:#f7f7f408}body .number{border:1px solid #f9452d;border-radius:0;background:transparent;color:#f9452d;font-family:ManiculeMono,monospace}body .prompt-text{color:#f7f7f4;font-family:ManiculeDisplay,Arial,sans-serif;font-size:19px}body .archetype{color:#77746c}body .source{background:#f7f7f414;color:#f7f7f4}body .kind{background:#f9452d1a;color:#f9452d}body .evidence{border-color:#f7f7f42e;background:#0f0e09}body .evidence-copy{color:#a7a39a!important}body .citation{color:#f9452d}body .feedback{border-color:#f7f7f42e}body .feedback button{border-color:#f7f7f44d;background:transparent;color:#f7f7f4;border-radius:0;text-transform:uppercase;font-size:10px;letter-spacing:.06em}body .feedback button:hover{border-color:#f9452d;color:#f9452d}body .coverage-summary summary{color:#f9452d}body .coverage-summary strong{color:#f7f7f4}body .back-home{color:#f9452d;text-transform:uppercase;letter-spacing:.08em}body .prompt-dialog{border-color:#f7f7f44d;border-radius:0;background:#14120b;color:#f7f7f4}body .dialog-form p{color:#a7a39a}body .dialog-form textarea{border-color:#f7f7f466;background:#0f0e09;color:#f7f7f4;border-radius:0}
.evidence-heading{font-weight:800;margin-bottom:2px}.evidence-note{color:#647077;font-size:12px;margin-bottom:3px}.evidence-item{padding-top:5px!important;padding-bottom:5px!important}.evidence-copy{color:#455158!important}.citation{color:#0e7182;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none}.citation:hover{text-decoration:underline}.feedback{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;padding-top:12px;border-top:1px solid #e5ebed}.feedback button{border:1px solid #cbd8dc;background:#fff;padding:7px 10px;font-weight:700}.feedback button:hover{border-color:#0e7182;color:#0e7182}.feedback .remove{color:#9b3131}.feedback-status{color:#647077;font-size:12px}.coverage-summary{padding:13px 16px!important;margin-bottom:16px}.coverage-summary strong{color:#26353b}.coverage-summary details{display:inline;margin-left:8px}.coverage-summary summary{display:inline;color:#0e7182;cursor:pointer;font-weight:700}.coverage-detail{margin-top:10px;color:#647077;font-size:13px}.prompt-dialog{width:min(560px,calc(100% - 28px));border:1px solid #cbd8dc;border-radius:12px;padding:0;box-shadow:0 24px 80px #17262f33}.prompt-dialog::backdrop{background:#15242d66}.dialog-form{padding:24px}.dialog-form h2{margin:0 0 6px}.dialog-form p{margin:0 0 16px;color:#647077}.dialog-form textarea{width:100%;min-height:116px;resize:vertical;border:1px solid #b9c8cd;padding:12px;font:15px/1.5 inherit}.dialog-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:14px}.dialog-error{color:#a33;font-size:13px;min-height:20px;margin-top:8px}.add-prompt{background:#0e7182!important;color:#fff!important;border-color:#0e7182!important}
.shell.results-mode{background:#14120b}.shell.results-mode .hero{display:none}.shell.results-mode .results{min-height:100vh;border-top:0}.back-home{display:block;border:0;background:transparent;color:#f9452d;padding:0 0 12px;font-weight:800}
:root{color-scheme:light;--ink:#111719;--muted:#647077;--soft:#87939a;--line:#dce4e7;--wash:#f4f8f9;--teal:#0e7182;--teal-dark:#075766;--blue:#3b82f6;--green:#147a55;--amber:#9a6612}
*{box-sizing:border-box}body{margin:0;background:#edf2f3;color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}button,input{font:inherit}button{cursor:pointer}.shell{width:min(1180px,calc(100% - 28px));min-height:calc(100vh - 28px);margin:14px auto;background:#fff;border:1px solid #d8e0e2}.hero{padding:70px 24px 58px;text-align:center;background:radial-gradient(circle at 85% 15%,#e3f3ff 0,transparent 32%),#fff}.eyebrow{color:var(--teal);font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.hero h1{max-width:700px;margin:14px auto 18px;font-size:clamp(38px,5vw,66px);line-height:1.05;letter-spacing:-.045em}.lede{max-width:700px;margin:0 auto 30px;color:#59656b;font-size:19px}.domain-form{display:flex;max-width:760px;margin:0 auto}.domain-form input{min-width:0;flex:1;border:1px solid var(--teal);border-right:0;padding:17px 19px;font:18px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}.domain-form input:focus{box-shadow:inset 0 0 0 2px #b8e3eb}.primary{border:0;background:var(--teal);color:#fff;padding:0 28px;font-weight:800}.primary:hover{background:var(--teal-dark)}.primary:disabled{opacity:.55;cursor:wait}.recorded{display:flex;justify-content:center;align-items:center;gap:9px;flex-wrap:wrap;margin-top:28px;color:var(--soft)}.domain-chip{border:1px solid #d6dfe2;background:#f7f9fa;padding:6px 11px;color:#536068;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}.domain-chip:hover{border-color:var(--teal);color:var(--teal)}.note{max-width:610px;margin:25px auto 0;color:#8a969c;font-size:13px}.progress{display:none;padding:48px 24px 70px;text-align:center;background:linear-gradient(110deg,#fff,#eef7ff)}.progress.visible{display:block}.pulse{width:54px;height:54px;margin:auto;border-radius:50%;border:3px solid #dbeafe;border-top-color:var(--blue);animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.progress h2{font-size:27px;margin:20px 0 7px}.steps{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:24px}.step{border:1px solid #cfe0f2;border-radius:999px;background:#fff;padding:9px 16px;color:#55708b}.results{display:none;padding:42px clamp(18px,5vw,62px) 70px;background:var(--wash);border-top:1px solid var(--line)}.results.visible{display:block}.result-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:24px}.result-head h2{font-size:30px;margin:0 0 3px;letter-spacing:-.025em}.meta{display:flex;gap:9px;flex-wrap:wrap;color:var(--muted);font-size:13px}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;background:#e5f5ef;color:var(--green);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}.pill.insufficient_evidence{background:#fff4dc;color:var(--amber)}.refresh{border:1px solid #b9c8cd;background:#fff;padding:10px 14px;font-weight:700}.prompt-list{display:grid;gap:13px}.prompt{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}.prompt-main{display:grid;grid-template-columns:45px 1fr auto;gap:14px;align-items:start;padding:19px}.number{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#e9f4f6;color:var(--teal);font-weight:800}.prompt-text{font-size:17px;font-weight:680;line-height:1.4}.archetype{margin-top:7px;color:var(--soft);font-size:12px;text-transform:uppercase;letter-spacing:.07em}.evidence-toggle{border:1px solid #cbd8dc;background:#fff;color:var(--teal);padding:8px 11px;font-size:13px;font-weight:750}.evidence{display:none;border-top:1px solid var(--line);background:#fbfcfc;padding:14px 19px 17px 78px}.evidence.open{display:grid;gap:9px}.evidence-item{border-left:3px solid #9bcbd3;padding:4px 0 4px 12px}.evidence-top{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:3px}.source,.kind{border-radius:4px;padding:2px 6px;font-size:11px;font-weight:800;text-transform:uppercase}.source{background:#e7f1f4;color:#315b64}.kind{background:#eef0ff;color:#4d55a8}.evidence-copy{color:#556168;font-size:13px}.freshness{color:#929da2;font-size:11px}.empty{padding:30px;background:#fff;border:1px solid var(--line);color:var(--muted)}.error{display:none;max-width:760px;margin:14px auto 0;color:#a33;background:#fff0f0;border:1px solid #f1cccc;padding:10px 13px;text-align:left}.error.visible{display:block}@media(max-width:700px){.shell{width:100%;margin:0;border:0}.hero{padding-top:50px}.domain-form{display:grid}.domain-form input{border-right:1px solid var(--teal)}.primary{padding:15px}.result-head{align-items:start;flex-direction:column}.prompt-main{grid-template-columns:38px 1fr}.evidence-toggle{grid-column:2}.evidence{padding-left:19px}}
</style></head><body><main class="shell"><section class="hero"><div class="eyebrow">Manicule · AgentRel</div><h1>Which prompts should your company track?</h1><p class="lede">Enter a domain. We read what buyers actually write across public and connected sources, then build the questions they ask AI agents.</p><form id="domain-form" class="domain-form"><input id="domain" name="domain" inputmode="url" autocomplete="url" placeholder="https://yourcompany.com" aria-label="Company domain" required><button id="submit" class="primary" type="submit">Find prompts</button></form><div id="error" class="error" role="alert"></div><div class="recorded"><span>Recorded runs</span><span id="chips"></span></div><p class="note">Known companies use realistic connected-source fixtures. New B2B software domains generate inferred opportunities from public product evidence only.</p></section><section id="progress" class="progress" aria-live="polite"><div class="pulse"></div><h2>Analyzing <span id="progress-domain"></span></h2><p>Building a traceable evidence set before generating prompts.</p><div class="steps"><span class="step">1 · Reading sources</span><span class="step">2 · Retrieving buyer context</span><span class="step">3 · Validating evidence</span></div></section><section id="results" class="results" aria-live="polite"></section></main><dialog id="prompt-dialog" class="prompt-dialog"><form id="prompt-dialog-form" class="dialog-form"><h2 id="prompt-dialog-title">Add prompt</h2><p id="prompt-dialog-copy">Add a question you want to track as a stable benchmark.</p><textarea id="prompt-dialog-text" maxlength="220" required aria-label="Prompt text"></textarea><div id="prompt-dialog-error" class="dialog-error" role="alert"></div><div class="dialog-actions"><button id="prompt-dialog-cancel" class="refresh" type="button">Cancel</button><button id="prompt-dialog-save" class="primary" type="submit">Save prompt</button></div></form></dialog><script src="/app.js"></script></body></html>`;

const clientJs = `
const shell=document.querySelector('.shell'),form=document.querySelector('#domain-form'),input=document.querySelector('#domain'),submit=document.querySelector('#submit'),chips=document.querySelector('#chips'),progress=document.querySelector('#progress'),progressDomain=document.querySelector('#progress-domain'),results=document.querySelector('#results'),errorBox=document.querySelector('#error'),heroLede=document.querySelector('.lede'),heroNote=document.querySelector('.note'),promptDialog=document.querySelector('#prompt-dialog'),promptDialogForm=document.querySelector('#prompt-dialog-form'),promptDialogTitle=document.querySelector('#prompt-dialog-title'),promptDialogCopy=document.querySelector('#prompt-dialog-copy'),promptDialogText=document.querySelector('#prompt-dialog-text'),promptDialogError=document.querySelector('#prompt-dialog-error'),promptDialogCancel=document.querySelector('#prompt-dialog-cancel');
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let state={companies:[],runs:[]},activeRun=null,dialogMode='add',dialogPrompt=null;
heroLede.textContent='Enter a domain. We turn real buyer language from public and private context into ten evidence-backed questions worth tracking.';heroNote.textContent='Recorded runs use realistic connected-source fixtures. New domains use public evidence only.';
function cleanDomain(value){try{return new URL(value.includes('://')?value:'https://'+value).hostname.toLowerCase().replace(/^www\\./,'')}catch{return value.trim().toLowerCase().replace(/^https?:\\/\\//,'').split('/')[0].replace(/^www\\./,'')}}
function formatDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?'Unknown date':date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}
function showError(message){errorBox.textContent=message;errorBox.classList.toggle('visible',Boolean(message))}
async function load(){const response=await fetch('/api/runs');if(!response.ok)throw new Error('Could not load recorded runs');state=await response.json();chips.innerHTML=state.companies.map(c=>'<button class="domain-chip" data-domain="'+escapeHtml(c.domain)+'">'+escapeHtml(c.domain)+'</button>').join(' ');document.querySelectorAll('[data-domain]').forEach(button=>button.onclick=()=>showRecorded(button.dataset.domain));}
function showRecorded(domain){const normalized=cleanDomain(domain);const run=state.runs.find(item=>cleanDomain(item.domain)===normalized);input.value=domain;if(run)render(run);else analyze(domain)}
function showLanding(push=true){activeRun=null;shell.classList.remove('results-mode');progress.classList.remove('visible');results.classList.remove('visible');showError('');if(push)history.pushState({},'', '/');window.scrollTo({top:0,behavior:'smooth'})}
function promptEvidence(prompt,run){const seen=new Set();const unique=prompt.evidenceIds.map(id=>run.evidence&&run.evidence[id]).filter(Boolean).filter(record=>{const key=record.artifactId||record.sourceLocator;if(seen.has(key))return false;seen.add(key);return true});const demand=unique.filter(record=>record.kind==='demand'||record.kind==='language').slice(0,2);const fit=unique.filter(record=>record.kind!=='demand'&&record.kind!=='language').slice(0,2);const selected=[...demand,...fit];return [...selected,...unique.filter(record=>!selected.includes(record))].slice(0,4)}
function evidenceRole(record){return record.kind==='demand'||record.kind==='language'?'Buyer demand':'Company fit'}
function citationHtml(record){const line=record.sourceLine?' · line '+record.sourceLine:'';const prefix=record.source+':';const nativeLocator=record.sourceLocator.startsWith(prefix)?record.sourceLocator.slice(prefix.length):record.sourceLocator;const label=record.source.toUpperCase()+' · '+nativeLocator+line;if(!record.sourceUrl)return '<span class="citation">'+escapeHtml(label)+'</span>';const href=record.sourceUrl+(record.sourceLine&&record.source==='github'?'#L'+record.sourceLine:'');return '<a class="citation" href="'+escapeHtml(href)+'" target="_blank" rel="noreferrer">'+escapeHtml(label)+'</a>'}
function evidenceHtml(prompt,run){const records=promptEvidence(prompt,run);const evidence=records.length?'<div class="evidence-heading">Why track this prompt?</div><div class="evidence-note">'+records.length+' supporting citation'+(records.length===1?'':'s')+'.</div>'+records.map(record=>'<article class="evidence-item"><div class="evidence-top"><span class="kind">'+evidenceRole(record)+'</span><span class="freshness">'+formatDate(record.occurredAt)+'</span></div><div class="evidence-copy">'+escapeHtml(record.summary)+'</div><div>'+citationHtml(record)+'</div></article>').join(''):'<div class="evidence-copy">'+(prompt.origin==='customer-authored'?'Added directly by the customer; no retrieved evidence is claimed.':'No displayable evidence was retained for this prompt.')+'</div>';const pin=prompt.set==='benchmark'?'<button disabled>Benchmark</button>':'<button data-action="pin" data-prompt="'+escapeHtml(prompt.id)+'">Keep as benchmark</button>';return evidence+'<div class="feedback">'+pin+'<button data-action="edit" data-prompt="'+escapeHtml(prompt.id)+'">Edit</button><button class="remove" data-action="remove" data-prompt="'+escapeHtml(prompt.id)+'">Remove</button><span class="feedback-status"></span></div>'}
function findPrompt(id){return [...(activeRun&&activeRun.benchmarkPrompts||[]),...(activeRun&&activeRun.discoveryPrompts||[])].find(prompt=>prompt.id===id)}
function openPromptDialog(mode,prompt){dialogMode=mode;dialogPrompt=prompt||null;promptDialogTitle.textContent=mode==='add'?'Add prompt':'Edit prompt';promptDialogCopy.textContent=mode==='add'?'Add a question you want to track as a stable benchmark.':'Update the question while keeping its history and benchmark results.';promptDialogText.value=prompt&&prompt.text||'';promptDialogError.textContent='';promptDialog.showModal();promptDialogText.focus()}
async function requestJson(url,options){const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not save prompt');return body}
async function refreshActive(){const domain=activeRun&&activeRun.domain;await load();if(domain)showRecorded(domain)}
function render(run){
  activeRun=run;shell.classList.add('results-mode');history.replaceState({domain:run.domain},'', '/prompts?domain='+encodeURIComponent(run.domain));progress.classList.remove('visible');results.classList.add('visible');const discovery=run.discoveryPrompts||[],benchmarks=run.benchmarkPrompts||[];const benchmarkKeys=new Set(benchmarks.map(p=>p.semanticKey||p.id));const prompts=[...benchmarks,...discovery.filter(p=>!benchmarkKeys.has(p.semanticKey||p.id))].slice(0,10);const status=String(run.status||'').replaceAll('_',' ');const health=run.sourceHealth||[];const healthy=health.filter(item=>item.status==='healthy').length;
  const cards=prompts.length?'<div class="prompt-list">'+prompts.map((prompt,index)=>'<article class="prompt"><div class="prompt-main"><div class="number">'+(index+1)+'</div><div><div class="prompt-text">'+escapeHtml(prompt.text)+'</div><div class="archetype"><span class="kind">'+escapeHtml(prompt.origin)+'</span> <span class="source">'+escapeHtml(prompt.set)+' set</span> · '+escapeHtml(prompt.archetype)+' · '+escapeHtml(prompt.coverage.audience)+' · '+escapeHtml(prompt.coverage.decisionStage)+'</div></div><button class="evidence-toggle" data-evidence="evidence-'+index+'">Sources · '+promptEvidence(prompt,run).length+'</button></div><div class="evidence" id="evidence-'+index+'">'+evidenceHtml(prompt,run)+'</div></article>').join('')+'</div>':'<div class="empty"><strong>No prompt set was fabricated.</strong><br>'+escapeHtml((run.missingEvidence&&run.missingEvidence[0]&&run.missingEvidence[0].reason)||run.error||'More evidence is required.')+'</div>';
  const lifecycle=run.promptLifecycle?'<span>'+run.promptLifecycle.retained+' retained · '+Math.round(run.promptLifecycle.churnRate*100)+'% churn</span>':'';
  const coverage=run.coverage?'<div class="empty coverage-summary"><strong>Prompt diversity:</strong> '+run.coverage.useCases.length+' buying situations across '+run.coverage.audiences.length+' audiences · '+escapeHtml(run.coverage.decisionStages.map(stage=>stage.charAt(0).toUpperCase()+stage.slice(1)).join(' + '))+'<details><summary>View breakdown</summary><div class="coverage-detail"><strong>Audiences:</strong> '+escapeHtml(run.coverage.audiences.join(', '))+'<br><strong>Use cases:</strong> '+escapeHtml(run.coverage.useCases.join(', '))+(run.coverage.missing.length?'<br><strong>Coverage gaps:</strong> '+escapeHtml(run.coverage.missing.join(', ')):'')+'</div></details></div>':'';
  results.innerHTML='<button class="back-home" id="back-home">← New domain</button><div class="result-head"><div><div class="eyebrow">Evidence-backed opportunities</div><h2>'+escapeHtml(run.companyName)+'</h2><div class="meta"><span class="pill '+escapeHtml(run.status)+'">'+escapeHtml(status)+'</span><span>'+discovery.length+' discovery · '+benchmarks.length+' benchmark</span><span>'+escapeHtml(run.metrics&&run.metrics.evidenceRetrieved||0)+' evidence records retrieved</span>'+lifecycle+'<span>'+healthy+' checked sources healthy</span><span>'+escapeHtml(run.provider)+'</span></div></div><div><button class="refresh add-prompt" id="add-prompt">+ Add prompt</button> <button class="refresh" id="trace">Run trace</button> <button class="refresh" id="refresh">Refresh analysis</button></div></div>'+coverage+'<div id="trace-summary"></div>'+cards;
  document.querySelector('#back-home').onclick=()=>showLanding();document.querySelector('#refresh').onclick=()=>analyze(run.domain);document.querySelector('#add-prompt').onclick=()=>openPromptDialog('add');document.querySelector('#trace').onclick=async()=>{const panel=document.querySelector('#trace-summary');panel.innerHTML='<div class="empty">Loading trace…</div>';try{const response=await fetch('/api/runs/'+encodeURIComponent(run.runId)+'/trace');const trace=await response.json();if(!response.ok)throw new Error(trace.error||'Trace unavailable');panel.innerHTML='<div class="empty"><strong>'+trace.totalEvents+' trace events · '+Math.round(trace.durationMs/1000)+'s</strong><br>Stages: '+Object.entries(trace.stages).map(([key,value])=>escapeHtml(key)+': '+value).join(' · ')+'<br>Reconciliation: '+(Object.entries(trace.reconciliation).map(([key,value])=>escapeHtml(key)+': '+value).join(' · ')||'none')+'<br>Privacy transformations: '+(trace.privacyTransformations||[]).length+' inspectable records (hashes + rules, no raw private text)<br>Top rejections: '+(trace.rejectionReasons.map(item=>escapeHtml(item[0])+': '+item[1]).join(' · ')||'none')+'</div>'}catch(error){panel.innerHTML='<div class="empty">'+escapeHtml(error.message)+'</div>'}};
  document.querySelectorAll('[data-evidence]').forEach(button=>button.onclick=()=>{const panel=document.getElementById(button.dataset.evidence);const open=panel.classList.toggle('open');button.setAttribute('aria-expanded',String(open));});document.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{const prompt=findPrompt(button.dataset.prompt);if(!prompt)return;if(button.dataset.action==='edit'){openPromptDialog('edit',prompt);return}if(button.dataset.action==='remove'&&!confirm('Remove this prompt from the tracking set?'))return;button.disabled=true;const status=button.parentElement.querySelector('.feedback-status');try{const verdict=button.dataset.action==='pin'?'approved':'rejected';await requestJson('/api/prompts/'+encodeURIComponent(run.companyId)+'/'+encodeURIComponent(prompt.id)+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verdict,reason:verdict==='rejected'?'other':undefined,ruleScope:'prompt'})});status.textContent=verdict==='approved'?'Saved as benchmark':'Removed';await refreshActive()}catch(error){status.textContent=error.message;button.disabled=false}});results.scrollIntoView({behavior:'smooth',block:'start'});
}
async function waitForJob(jobId){const deadline=Date.now()+15*60*1000;while(Date.now()<deadline){const response=await fetch('/api/jobs/'+encodeURIComponent(jobId));const body=await response.json();if(!response.ok)throw new Error(body.error||'Could not read analysis job');if(body.status==='cancelled')throw new Error('Analysis was cancelled');if(body.status==='complete'||body.status==='failed'){if(body.result)return body.result;throw new Error(body.error||'Analysis failed')}await new Promise(resolve=>setTimeout(resolve,1000))}throw new Error('Analysis is still running; reload this page to check recorded runs.')}
async function analyze(domain){showError('');const normalized=cleanDomain(domain);if(!normalized){showError('Enter a valid company domain.');return}shell.classList.add('results-mode');if(location.pathname==='/prompts')history.replaceState({domain:normalized},'', '/prompts?domain='+encodeURIComponent(normalized));else history.pushState({domain:normalized},'', '/prompts?domain='+encodeURIComponent(normalized));submit.disabled=true;submit.textContent='Analyzing…';progressDomain.textContent=normalized;progress.classList.add('visible');results.classList.remove('visible');try{const response=await fetch('/api/run-domain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain:normalized})});const body=await response.json();if(!response.ok)throw new Error(body.error||'Analysis failed');const result=await waitForJob(body.jobId);render(result);await load()}catch(error){showLanding(false);showError(error.message||String(error))}finally{submit.disabled=false;submit.textContent='Find prompts'}}
form.addEventListener('submit',event=>{event.preventDefault();analyze(input.value)});
promptDialogCancel.addEventListener('click',()=>promptDialog.close());
promptDialogForm.addEventListener('submit',async event=>{event.preventDefault();if(!activeRun)return;const save=document.querySelector('#prompt-dialog-save');save.disabled=true;promptDialogError.textContent='';try{const text=promptDialogText.value;if(dialogMode==='add'){await requestJson('/api/companies/'+encodeURIComponent(activeRun.companyId)+'/prompts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})}else if(dialogPrompt){await requestJson('/api/prompts/'+encodeURIComponent(activeRun.companyId)+'/'+encodeURIComponent(dialogPrompt.id)+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verdict:'edited',editedText:text,ruleScope:'prompt'})})}promptDialog.close();await refreshActive()}catch(error){promptDialogError.textContent=error.message}finally{save.disabled=false}});
window.addEventListener('popstate',()=>{const domain=new URLSearchParams(location.search).get('domain');if(location.pathname==='/prompts'&&domain)showRecorded(domain);else showLanding(false)});
load().then(()=>{const domain=new URLSearchParams(location.search).get('domain');if(location.pathname==='/prompts'&&domain)showRecorded(domain)}).catch(error=>showError(error.message));
`;
