import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { EvidenceRetriever } from "./retrieval/retriever.js";
import { EvidenceDatabase } from "./store/database.js";
import { SOURCE_TYPES, type EvidenceKind, type EvidenceNeed, type TraceEvent } from "./types.js";

const KINDS = ["capability", "demand", "constraint", "comparison", "language", "change"] as const;
const statusSchema = z.enum(["pending", "reviewed", "adjudicated"]);
const retrievalJudgmentSchema = z.object({
  reviewerId: z.string().min(1), reviewedAt: z.string(), relevantEvidenceIds: z.array(z.string()),
  missedRelevantEvidenceIds: z.array(z.string()).optional(), forbiddenEvidenceIds: z.array(z.string()), notes: z.string().optional(),
});
const retrievalCaseSchema = z.object({
  id: z.string(), companyId: z.string(), topic: z.string(), variant: z.string(), query: z.string(),
  kinds: z.array(z.enum(KINDS)), accessScopes: z.array(z.string()), candidateEvidenceIds: z.array(z.string()).max(50),
  rankedEvidenceIds: z.array(z.string()).max(12),
  claimGroupKeys: z.record(z.string(), z.string()).optional(),
  status: statusSchema, judgments: z.array(retrievalJudgmentSchema),
  resolution: retrievalJudgmentSchema.optional(),
});
const promptGradeSchema = z.object({
  reviewerId: z.string().min(1), reviewedAt: z.string(), buyerIntent: z.number().int().min(1).max(5),
  recommendationLikelihood: z.number().int().min(1).max(5), evidenceEntailment: z.number().int().min(1).max(5),
  distinctness: z.number().int().min(1).max(5), naturalness: z.number().int().min(1).max(5),
  accept: z.boolean(), notes: z.string().optional(),
});
const promptCaseSchema = z.object({
  id: z.string(), companyId: z.string(), promptId: z.string(), text: z.string(), evidenceIds: z.array(z.string()),
  automatedDecision: z.enum(["accepted", "rejected"]), automatedFindings: z.array(z.string()),
  status: statusSchema, grades: z.array(promptGradeSchema), resolution: promptGradeSchema.optional(),
});
const retrievalCorpusSchema = z.object({ schemaVersion: z.literal(1), generatedAt: z.string(), targetCases: z.literal(150), cases: z.array(retrievalCaseSchema).length(150) });
const promptCorpusSchema = z.object({ schemaVersion: z.literal(1), generatedAt: z.string(), targetCases: z.literal(200), cases: z.array(promptCaseSchema).length(200) });

export type RetrievalAnnotationCase = z.infer<typeof retrievalCaseSchema>;
export type PromptAnnotationCase = z.infer<typeof promptCaseSchema>;
export interface HumanEvalReport {
  retrieval: { total: number; reviewed: number; adjudicated: number; recallAt3?: number; recallAt12?: number; precisionAt12?: number; forbiddenHitRate?: number; reviewerAgreement?: number };
  prompts: { total: number; graded: number; adjudicated: number; acceptanceRate?: number; averageBuyerIntent?: number; averageRecommendationLikelihood?: number; averageEvidenceEntailment?: number; averageDistinctness?: number; averageNaturalness?: number; reviewerAgreement?: number };
  requirements: { retrievalMinimum: number; promptMinimum: number; met: boolean };
  passed: boolean;
}

export async function prepareHumanEvaluation(config: AppConfig): Promise<{ retrievalCases: number; promptCases: number; directory: string }> {
  const directory = path.join(config.rootDir, "eval", "annotations");
  await mkdir(directory, { recursive: true });
  using db = new EvidenceDatabase(config.dbPath);
  const retrievalPath = path.join(directory, "retrieval.json");
  const promptPath = path.join(directory, "prompts.json");
  const oldRetrieval = await optionalCorpus(retrievalPath, retrievalCorpusSchema);
  const oldPrompts = await optionalCorpus(promptPath, promptCorpusSchema);
  const priorRetrieval = new Map(oldRetrieval?.cases.map(item => [item.id, item]) ?? []);
  const priorPrompts = new Map(oldPrompts?.cases.map(item => [item.id, item]) ?? []);
  const retriever = new EvidenceRetriever(db);
  const completedResults = db.latestResults().filter(result => result.status === "complete");
  const retrievalBuckets = completedResults.map(result => topicPlans(db.traceForRun(result.runId)).slice(0, 10).flatMap(topic => {
    const variants: Array<{ name: string; query: string; kinds: EvidenceKind[] }> = [
      { name: "natural", query: topic.query, kinds: [...KINDS] },
      { name: "category", query: `best tools or platforms for ${topic.query}`, kinds: ["demand", "language", "capability", "comparison"] },
      { name: "capability", query: `which products support ${topic.query}`, kinds: ["capability", "change", "constraint"] },
    ];
    return variants.map(variant => buildRetrievalCase(retriever, result.companyId, topic.slug, variant.name, variant.query, variant.kinds, priorRetrieval));
  }));
  const retrievalCases = balancedTake(retrievalBuckets, 150);
  if (retrievalCases.length !== 150) throw new Error(`Expected 150 retrieval cases, prepared ${retrievalCases.length}`);

  const buckets = completedResults
    .map(result => candidateCases(result.companyId, db.traceForRun(result.runId), priorPrompts));
  const promptCases = balancedTake(buckets, 200);
  if (promptCases.length < 200) {
    throw new Error(`Need at least 200 traced prompt candidates across completed companies; found ${promptCases.length}. Run more companies first.`);
  }
  await atomicJson(retrievalPath, { schemaVersion: 1, generatedAt: new Date().toISOString(), targetCases: 150, cases: retrievalCases });
  await atomicJson(promptPath, { schemaVersion: 1, generatedAt: new Date().toISOString(), targetCases: 200, cases: promptCases });
  return { retrievalCases: retrievalCases.length, promptCases: promptCases.length, directory };
}

export async function evaluateHumanAnnotations(rootDir: string): Promise<HumanEvalReport> {
  const directory = path.join(rootDir, "eval", "annotations");
  const retrieval = retrievalCorpusSchema.parse(JSON.parse(await readFile(path.join(directory, "retrieval.json"), "utf8")));
  const prompts = promptCorpusSchema.parse(JSON.parse(await readFile(path.join(directory, "prompts.json"), "utf8")));
  const retrievalReviewed = retrieval.cases.filter(item => item.judgments.length > 0);
  const promptGraded = prompts.cases.filter(item => item.grades.length > 0);
  const retrievalMetrics = retrievalQuality(retrievalReviewed);
  const promptMetrics = promptQuality(promptGraded);
  const requirementsMet = retrievalReviewed.length >= 100 && promptGraded.length >= 200;
  const passed = requirementsMet && (retrievalMetrics.recallAt12 ?? 0) >= 0.85 && (retrievalMetrics.precisionAt12 ?? 0) >= 0.6 &&
    (retrievalMetrics.forbiddenHitRate ?? 1) === 0 && (promptMetrics.acceptanceRate ?? 0) >= 0.8 &&
    (promptMetrics.averageRecommendationLikelihood ?? 0) >= 4 && (promptMetrics.averageEvidenceEntailment ?? 0) >= 4;
  return {
    retrieval: { total: retrieval.cases.length, reviewed: retrievalReviewed.length, adjudicated: retrieval.cases.filter(item => item.resolution).length, ...retrievalMetrics },
    prompts: { total: prompts.cases.length, graded: promptGraded.length, adjudicated: prompts.cases.filter(item => item.resolution).length, ...promptMetrics },
    requirements: { retrievalMinimum: 100, promptMinimum: 200, met: requirementsMet }, passed,
  };
}

function buildRetrievalCase(retriever: EvidenceRetriever, companyId: string, topic: string, variant: string, query: string,
  kinds: EvidenceKind[], prior: Map<string, RetrievalAnnotationCase>): RetrievalAnnotationCase {
  const id = `${companyId}:${topic}:${variant}`;
  const need: EvidenceNeed = { id, query, kinds, reason: "Human retrieval evaluation", preferredSources: [] };
  const candidateEvidenceIds = retriever.retrieve(companyId, [need], 50, { scopes: ["public", "company"] })[0]!.records.map(item => item.evidence.id);
  const rankedEvidenceIds = candidateEvidenceIds.slice(0, 12);
  const existing = prior.get(id);
  return { id, companyId, topic, variant, query, kinds, accessScopes: ["public", "company"], candidateEvidenceIds, rankedEvidenceIds,
    status: existing?.status ?? "pending", judgments: existing?.judgments ?? [], ...(existing?.resolution ? { resolution: existing.resolution } : {}) };
}

function topicPlans(events: TraceEvent[]): Array<{ slug: string; query: string }> {
  const event = [...events].reverse().find(item => item.stage === "retrieve" && item.action === "topic-plan-created");
  const schema = z.array(z.object({ slug: z.string(), query: z.string() }));
  const parsed = schema.safeParse(event?.data.topics);
  return parsed.success ? parsed.data : [];
}

function candidateCases(companyId: string, events: TraceEvent[], prior: Map<string, PromptAnnotationCase>): PromptAnnotationCase[] {
  const seen = new Set<string>();
  return events.filter(event => event.stage === "validate" && (event.action === "accepted" || event.action === "rejected")).flatMap(event => {
    const text = typeof event.data.text === "string" ? event.data.text : "";
    if (!event.subjectId || !text || seen.has(text.toLowerCase())) return [];
    seen.add(text.toLowerCase());
    const id = `${companyId}:${event.subjectId}`;
    const existing = prior.get(id);
    const findings = Array.isArray(event.data.findings) ? event.data.findings.flatMap(item => item && typeof item === "object" && "code" in item ? [String(item.code)] : []) : [];
    return [{ id, companyId, promptId: event.subjectId, text,
      evidenceIds: Array.isArray(event.data.evidenceIds) ? event.data.evidenceIds.filter((item): item is string => typeof item === "string") : [],
      automatedDecision: event.action as "accepted" | "rejected", automatedFindings: findings,
      status: existing?.status ?? "pending", grades: existing?.grades ?? [], ...(existing?.resolution ? { resolution: existing.resolution } : {}) }];
  });
}

function balancedTake<T>(buckets: T[][], target: number): T[] {
  const output: T[] = [];
  for (let index = 0; output.length < target; index += 1) {
    let added = false;
    for (const bucket of buckets) {
      const item = bucket[index];
      if (item !== undefined) { output.push(item); added = true; if (output.length === target) break; }
    }
    if (!added) break;
  }
  return output;
}

function retrievalQuality(cases: RetrievalAnnotationCase[]): Partial<HumanEvalReport["retrieval"]> {
  if (cases.length === 0) return {};
  let relevant = 0, hit3 = 0, hit12 = 0, retrieved = 0, relevantRetrieved = 0, forbidden = 0, forbiddenHits = 0;
  for (const item of cases) {
    const judgment = item.resolution ?? item.judgments[0]!;
    const relevantSet = new Set([...judgment.relevantEvidenceIds, ...(judgment.missedRelevantEvidenceIds ?? [])]);
    const forbiddenSet = new Set(judgment.forbiddenEvidenceIds);
    relevant += relevantSet.size; hit3 += item.rankedEvidenceIds.slice(0, 3).filter(id => relevantSet.has(id)).length;
    hit12 += item.rankedEvidenceIds.filter(id => relevantSet.has(id)).length; retrieved += item.rankedEvidenceIds.length;
    relevantRetrieved += item.rankedEvidenceIds.filter(id => relevantSet.has(id)).length; forbidden += forbiddenSet.size;
    forbiddenHits += item.rankedEvidenceIds.filter(id => forbiddenSet.has(id)).length;
  }
  const reviewerAgreement = retrievalAgreement(cases);
  return { recallAt3: relevant === 0 ? 1 : hit3 / relevant, recallAt12: relevant === 0 ? 1 : hit12 / relevant,
    precisionAt12: retrieved === 0 ? 1 : relevantRetrieved / retrieved, forbiddenHitRate: forbidden === 0 ? 0 : forbiddenHits / forbidden,
    ...(reviewerAgreement === undefined ? {} : { reviewerAgreement }) };
}

function promptQuality(cases: PromptAnnotationCase[]): Partial<HumanEvalReport["prompts"]> {
  if (cases.length === 0) return {};
  const grades = cases.map(item => item.resolution ?? item.grades[0]!);
  const average = (key: "buyerIntent" | "recommendationLikelihood" | "evidenceEntailment" | "distinctness" | "naturalness") => grades.reduce((sum, grade) => sum + grade[key], 0) / grades.length;
  const reviewerAgreement = promptAgreement(cases);
  return { acceptanceRate: grades.filter(item => item.accept).length / grades.length, averageBuyerIntent: average("buyerIntent"),
    averageRecommendationLikelihood: average("recommendationLikelihood"), averageEvidenceEntailment: average("evidenceEntailment"),
    averageDistinctness: average("distinctness"), averageNaturalness: average("naturalness"),
    ...(reviewerAgreement === undefined ? {} : { reviewerAgreement }) };
}

function retrievalAgreement(cases: RetrievalAnnotationCase[]): number | undefined {
  const overlaps = cases.filter(item => item.judgments.length >= 2);
  if (overlaps.length === 0) return undefined;
  return overlaps.reduce((sum, item) => {
    const left = new Set(item.judgments[0]!.relevantEvidenceIds); const right = new Set(item.judgments[1]!.relevantEvidenceIds);
    return sum + [...new Set([...left, ...right])].filter(id => left.has(id) === right.has(id)).length / Math.max(1, new Set([...left, ...right]).size);
  }, 0) / overlaps.length;
}

function promptAgreement(cases: PromptAnnotationCase[]): number | undefined {
  const overlaps = cases.filter(item => item.grades.length >= 2);
  return overlaps.length === 0 ? undefined : overlaps.filter(item => item.grades[0]!.accept === item.grades[1]!.accept).length / overlaps.length;
}

async function optionalCorpus<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try { return schema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
