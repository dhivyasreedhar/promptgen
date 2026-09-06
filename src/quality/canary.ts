import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { judgeCurrentPrompts } from "../eval-llm-judge.js";
import { runCompany } from "../pipeline/run.js";
import { transformEvidenceForExternal } from "../privacy/transform.js";
import { EvidenceDatabase } from "../store/database.js";
import { PostgresMetadataStore } from "../store/postgres-metadata.js";
import type { CompanyConfig, RunResult } from "../types.js";
import { isoNow, log, normalizeText } from "../util.js";

export interface CanaryAttempt {
  profile: "standard" | "expanded";
  runId: string;
  promptCount: number;
  passed: boolean;
  acceptanceRate: number;
  averages: Record<"buyerIntent" | "recommendationLikelihood" | "evidenceEntailment" | "distinctness" | "naturalness", number>;
  failures: string[];
}

export interface CompanyCanaryResult {
  companyId: string;
  passed: boolean;
  promotedRunId?: string;
  retainedPrevious: boolean;
  alreadyPublished?: boolean;
  attempts: CanaryAttempt[];
}

export interface DailyCanaryReport {
  id: string;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  state: "running" | "completed";
  companies: CompanyCanaryResult[];
}

const SCORE_KEYS = ["buyerIntent", "recommendationLikelihood", "evidenceEntailment", "distinctness", "naturalness"] as const;

/** Run the configured four-company suite and publish only independently passing results. */
export async function runDailyCanaries(config: AppConfig, fixtures: boolean): Promise<DailyCanaryReport> {
  const id = `canary-${randomUUID()}`;
  const startedAt = isoNow();
  const companies: CompanyCanaryResult[] = [];
  for (const company of config.companies.slice(0, 4)) {
    companies.push(await runCompanyCanary(config, company, fixtures));
    using checkpoint = new EvidenceDatabase(config.dbPath);
    checkpoint.recordCanaryReport({ id, startedAt, completedAt: isoNow(), passed: false, state: "running", companies });
  }
  const report: DailyCanaryReport = { id, startedAt, completedAt: isoNow(), passed: companies.every(item => item.passed), state: "completed", companies };
  using db = new EvidenceDatabase(config.dbPath);
  db.recordCanaryReport(report);
  log(report.passed ? "info" : "warn", "canary.completed", { id, passed: report.passed,
    companies: companies.map(item => ({ companyId: item.companyId, passed: item.passed, retainedPrevious: item.retainedPrevious })) });
  return report;
}

/** Re-grade the most recent staged set per company after judge/configuration repair, without regenerating prompts. */
export async function reassessStagedCanaries(config: AppConfig): Promise<DailyCanaryReport> {
  const id = `canary-reassess-${randomUUID()}`, startedAt = isoNow();
  using db = new EvidenceDatabase(config.dbPath);
  const priorReports = db.canaryReports<DailyCanaryReport>(20);
  const validlyJudged = new Set(priorReports.flatMap(report => report.companies ?? []).flatMap(company => company.attempts ?? [])
    .filter(attempt => attempt.acceptanceRate > 0).map(attempt => attempt.runId));
  const staged = new Map<string, RunResult[]>();
  for (const result of db.stagedResultsAfterLastPublished().filter(item => !validlyJudged.has(item.runId))) staged.set(result.companyId, [...(staged.get(result.companyId) ?? []), result]);
  const published = new Map(db.latestResults().filter(result => result.status === "complete" && result.discoveryPrompts.length === 10).map(result => [result.companyId, result]));
  const companies: CompanyCanaryResult[] = [];
  for (const company of config.companies.slice(0, 4)) {
    const candidates = staged.get(company.id)?.slice(0, 2) ?? [];
    if (!candidates.length) {
      const prior = published.get(company.id);
      companies.push({ companyId: company.id, passed: Boolean(prior), ...(prior ? { promotedRunId: prior.runId, alreadyPublished: true } : {}), retainedPrevious: !prior, attempts: [] });
      continue;
    }
    const attempts: CanaryAttempt[] = [];
    let promotedRunId: string | undefined;
    for (const [index, result] of candidates.entries()) {
      try {
        const assessment = await assessRun(config, result);
        attempts.push({ profile: index === 0 ? "expanded" : "standard", runId: result.runId, promptCount: result.discoveryPrompts.length, ...assessment });
        if (assessment.passed) {
          await promoteRun(config, company, result, db); promotedRunId = result.runId;
          break;
        }
      } catch (error) {
        attempts.push({ profile: index === 0 ? "expanded" : "standard", runId: result.runId, promptCount: result.discoveryPrompts.length,
          passed: false, acceptanceRate: 0, averages: Object.fromEntries(SCORE_KEYS.map(key => [key, 0])) as CanaryAttempt["averages"],
          failures: [error instanceof Error ? error.message : String(error)] });
      }
    }
    companies.push({ companyId: company.id, passed: Boolean(promotedRunId), ...(promotedRunId ? { promotedRunId } : {}), retainedPrevious: !promotedRunId, attempts });
    db.recordCanaryReport({ id, startedAt, completedAt: isoNow(), passed: false, state: "running", companies });
  }
  const report: DailyCanaryReport = { id, startedAt, completedAt: isoNow(), passed: companies.every(item => item.passed), state: "completed", companies };
  db.recordCanaryReport(report);
  return report;
}

async function runCompanyCanary(config: AppConfig, company: CompanyConfig, fixtures: boolean): Promise<CompanyCanaryResult> {
  const attempts: CanaryAttempt[] = [];
  for (const profile of ["standard", "expanded"] as const) {
    let result: RunResult | undefined;
    try {
      result = await runCompany(config, company, { fixtures, publish: false, qualityProfile: profile });
      const assessment = await assessRun(config, result);
      attempts.push({ profile, runId: result.runId, promptCount: result.discoveryPrompts.length, ...assessment });
      if (assessment.passed) {
        using db = new EvidenceDatabase(config.dbPath);
        await promoteRun(config, company, result, db);
        return { companyId: company.id, passed: true, promotedRunId: result.runId, retainedPrevious: false, attempts };
      }
    } catch (error) {
      attempts.push({ profile, runId: result?.runId ?? "unavailable", promptCount: result?.discoveryPrompts.length ?? 0,
        passed: false, acceptanceRate: 0, averages: Object.fromEntries(SCORE_KEYS.map(key => [key, 0])) as CanaryAttempt["averages"],
        failures: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return { companyId: company.id, passed: false, retainedPrevious: true, attempts };
}

export async function promoteRun(config: AppConfig, company: CompanyConfig, result: RunResult, db?: EvidenceDatabase): Promise<void> {
  const owned = db ?? new EvidenceDatabase(config.dbPath);
  try {
    owned.publishRun(result.runId);
    if (config.postgresUrl) {
      await using metadata = new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName);
      await metadata.finishRun(company, result, owned.sourceHealth(company.id), owned.traceForRun(result.runId), true);
    }
  } finally { if (!db) owned.close(); }
}

export async function assessRun(config: AppConfig, result: RunResult): Promise<Omit<CanaryAttempt, "profile" | "runId" | "promptCount">> {
  const failures: string[] = [];
  const emptyAverages = Object.fromEntries(SCORE_KEYS.map(key => [key, 0])) as CanaryAttempt["averages"];
  if (result.status !== "complete") failures.push(`pipeline status is ${result.status}`);
  if (result.discoveryPrompts.length !== 10) failures.push(`expected exactly 10 discovery prompts, received ${result.discoveryPrompts.length}`);
  const normalized = result.discoveryPrompts.map(prompt => normalizeText(prompt.text).toLowerCase());
  if (new Set(normalized).size !== normalized.length) failures.push("duplicate prompt text detected");
  if (result.discoveryPrompts.some(prompt => prompt.evidenceIds.length === 0)) failures.push("one or more prompts have no evidence");
  if (failures.length || !config.openaiApiKey) {
    if (!config.openaiApiKey) failures.push("OPENAI_API_KEY is unavailable for independent grading");
    return { passed: false, acceptanceRate: 0, averages: emptyAverages, failures };
  }

  using db = new EvidenceDatabase(config.dbPath);
  const ids = [...new Set(result.discoveryPrompts.flatMap(prompt => prompt.evidenceIds))];
  const evidenceById = new Map(db.evidenceByIds(ids).map(record => [record.id, record]));
  const payload = result.discoveryPrompts.map(prompt => ({ caseId: prompt.id, prompt: prompt.text,
    evidence: prompt.evidenceIds.flatMap(id => {
      const record = evidenceById.get(id); if (!record) return [];
      const safe = transformEvidenceForExternal(record).evidence; return safe ? [{ id, source: safe.source, kind: safe.kind, text: safe.safeSummary }] : [];
    }),
  }));
  if (payload.some(item => item.evidence.length === 0)) failures.push("one or more prompts have no externally safe evidence");
  if (failures.length) return { passed: false, acceptanceRate: 0, averages: emptyAverages, failures };

  const judged = await judgeCurrentPrompts(config, payload);
  const a = new Map(judged.a.map(item => [item.caseId, item]));
  const b = new Map(judged.b.map(item => [item.caseId, item]));
  const pairs = payload.flatMap(item => a.get(item.caseId) && b.get(item.caseId) ? [[a.get(item.caseId)!, b.get(item.caseId)!] as const] : []);
  if (pairs.length !== 10) failures.push(`judge returned two complete passes for ${pairs.length}/10 prompts`);
  const accepted = pairs.filter(([first, second]) => first.accept && second.accept).length;
  const acceptanceRate = accepted / Math.max(1, pairs.length);
  const averages = Object.fromEntries(SCORE_KEYS.map(key => [key, average(pairs.flatMap(pair => pair.map(item => item[key])))])) as CanaryAttempt["averages"];
  if (acceptanceRate < 0.8) failures.push(`two-pass acceptance ${percent(acceptanceRate)} is below 80%`);
  if (averages.buyerIntent < 4) failures.push("average buyer intent is below 4.0");
  if (averages.recommendationLikelihood < 4) failures.push("average recommendation likelihood is below 4.0");
  if (averages.evidenceEntailment < 4) failures.push("average evidence entailment is below 4.0");
  if (averages.distinctness < 3.5) failures.push("average distinctness is below 3.5");
  if (averages.naturalness < 4) failures.push("average naturalness is below 4.0");
  return { passed: failures.length === 0, acceptanceRate, averages, failures };
}

function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percent(value: number): string { return `${Math.round(value * 1_000) / 10}%`; }
