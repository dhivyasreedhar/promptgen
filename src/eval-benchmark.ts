import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { EvidenceExtractor } from "./evidence/extractor.js";
import { EvidenceRetriever } from "./retrieval/retriever.js";
import { EvidenceDatabase } from "./store/database.js";
import { SOURCE_TYPES, type EvidenceNeed, type SourceArtifact } from "./types.js";
import { hash } from "./util.js";

const benchmarkSchema = z.object({
  company: z.object({ id: z.string(), name: z.string(), domain: z.string(), category: z.string(), githubOrganizations: z.array(z.string()), enabledSources: z.array(z.enum(SOURCE_TYPES)) }),
  artifacts: z.array(z.object({ id: z.string(), source: z.enum(SOURCE_TYPES), visibility: z.enum(["public", "private", "synthetic"]), content: z.string(), metadata: z.record(z.unknown()) })),
  cases: z.array(z.object({ id: z.string(), query: z.string(), kinds: z.array(z.enum(["capability", "demand", "constraint", "comparison", "language", "change"])),
    expectedArtifactIds: z.array(z.string()), forbiddenArtifactIds: z.array(z.string()), accessScopes: z.array(z.string()) })),
});

export interface BenchmarkReport {
  cases: number;
  expectedRecallAt12: number;
  expectedRecallAt3: number;
  meanReciprocalRank: number;
  precisionAt12: number;
  forbiddenHitRate: number;
  accessLeakageRate: number;
  staleTruthLeakageRate: number;
  passed: boolean;
  results: Array<{ id: string; expected: string[]; retrieved: string[]; missing: string[]; forbiddenHits: string[] }>;
}

export async function evaluateIndependentBenchmark(config: AppConfig): Promise<BenchmarkReport> {
  const benchmark = benchmarkSchema.parse(JSON.parse(await readFile(path.join(config.rootDir, "fixtures/benchmark/retrieval.json"), "utf8")));
  const dbPath = path.join(tmpdir(), `promptgen-benchmark-${crypto.randomUUID()}.db`);
  try {
    using db = new EvidenceDatabase(dbPath);
    const now = "2026-09-04T00:00:00.000Z";
    const artifacts: SourceArtifact[] = benchmark.artifacts.map(item => ({ ...item, companyId: benchmark.company.id, externalId: item.id, version: "1",
      occurredAt: now, collectedAt: now, title: item.id }));
    db.upsertArtifacts(artifacts.map(artifact => ({ artifact, contentHash: hash(artifact.content) })));
    const extractor = new EvidenceExtractor();
    db.replaceEvidenceBatch(artifacts.map(artifact => ({ artifactId: artifact.id, extractorVersion: extractor.version, records: extractor.extract(artifact) })));
    const retriever = new EvidenceRetriever(db);
    const results = benchmark.cases.map(test => {
      const need: EvidenceNeed = { id: test.id, query: test.query, kinds: test.kinds, reason: "Independent retrieval benchmark", preferredSources: [] };
      const retrieved = [...new Set(retriever.retrieve(benchmark.company.id, [need], 12, { scopes: test.accessScopes })[0]!.records.map(item => item.evidence.artifactId))];
      return { id: test.id, expected: test.expectedArtifactIds, retrieved,
        missing: test.expectedArtifactIds.filter(id => !retrieved.includes(id)), forbiddenHits: test.forbiddenArtifactIds.filter(id => retrieved.includes(id)) };
    });
    const expectedCount = results.reduce((sum, item) => sum + item.expected.length, 0);
    const missingCount = results.reduce((sum, item) => sum + item.missing.length, 0);
    const forbiddenCount = benchmark.cases.reduce((sum, item) => sum + item.forbiddenArtifactIds.length, 0);
    const forbiddenHits = results.reduce((sum, item) => sum + item.forbiddenHits.length, 0);
    const retrievedCount = results.reduce((sum, item) => sum + item.retrieved.length, 0);
    const relevantRetrieved = results.reduce((sum, item) => sum + item.retrieved.filter(id => item.expected.includes(id)).length, 0);
    const expectedRecallAt12 = expectedCount === 0 ? 1 : (expectedCount - missingCount) / expectedCount;
    const recalledAt3 = results.reduce((sum, item) => sum + item.expected.filter(id => item.retrieved.slice(0, 3).includes(id)).length, 0);
    const expectedRecallAt3 = expectedCount === 0 ? 1 : recalledAt3 / expectedCount;
    const rankedCases = results.filter(item => item.expected.length > 0);
    const meanReciprocalRank = rankedCases.length === 0 ? 1 : rankedCases.reduce((sum, item) => {
      const first = item.retrieved.findIndex(id => item.expected.includes(id)); return sum + (first < 0 ? 0 : 1 / (first + 1));
    }, 0) / rankedCases.length;
    const precisionAt12 = retrievedCount === 0 ? 1 : relevantRetrieved / retrievedCount;
    const forbiddenHitRate = forbiddenCount === 0 ? 0 : forbiddenHits / forbiddenCount;
    const artifactById = new Map(benchmark.artifacts.map(item => [item.id, item]));
    const accessForbidden = results.flatMap(item => item.forbiddenHits).filter(id => {
      const artifact = artifactById.get(id); const scopes = artifact?.metadata.aclScopes;
      return artifact?.metadata.neverExpose === true || (Array.isArray(scopes) && !scopes.includes("public") && !scopes.includes("company"));
    });
    const staleForbidden = results.flatMap(item => item.forbiddenHits).filter(id => {
      const metadata = artifactById.get(id)?.metadata;
      return metadata?.lifecycle === "planned" || metadata?.lifecycle === "deprecated" || typeof metadata?.validTo === "string";
    });
    const accessDenominators = benchmark.artifacts.filter(item => item.metadata.neverExpose === true ||
      (Array.isArray(item.metadata.aclScopes) && !item.metadata.aclScopes.includes("public") && !item.metadata.aclScopes.includes("company"))).length;
    const staleDenominators = benchmark.artifacts.filter(item => item.metadata.lifecycle === "planned" || item.metadata.lifecycle === "deprecated" || typeof item.metadata.validTo === "string").length;
    const accessLeakageRate = accessForbidden.length / Math.max(1, accessDenominators);
    const staleTruthLeakageRate = staleForbidden.length / Math.max(1, staleDenominators);
    return { cases: results.length, expectedRecallAt12, expectedRecallAt3, meanReciprocalRank, precisionAt12,
      forbiddenHitRate, accessLeakageRate, staleTruthLeakageRate,
      passed: expectedRecallAt12 === 1 && expectedRecallAt3 === 1 && precisionAt12 === 1 && forbiddenHitRate === 0 &&
        accessLeakageRate === 0 && staleTruthLeakageRate === 0, results };
  } finally {
    await Promise.all(["", "-shm", "-wal"].map(suffix => rm(`${dbPath}${suffix}`, { force: true })));
  }
}
