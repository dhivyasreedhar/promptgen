import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateHumanAnnotations } from "../src/eval-human.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

describe("human evaluation gate", () => {
  it("does not pass empty annotation queues", async () => {
    const root = await corpus(false); const report = await evaluateHumanAnnotations(root);
    expect(report.retrieval.total).toBe(150); expect(report.retrieval.reviewed).toBe(0);
    expect(report.prompts.total).toBe(200); expect(report.prompts.graded).toBe(0);
    expect(report.requirements.met).toBe(false); expect(report.passed).toBe(false);
  });

  it("computes quality only from explicit reviewer judgments", async () => {
    const root = await corpus(true); const report = await evaluateHumanAnnotations(root);
    expect(report.retrieval.reviewed).toBe(100); expect(report.retrieval.recallAt3).toBe(1);
    expect(report.prompts.graded).toBe(200); expect(report.prompts.acceptanceRate).toBe(1);
    expect(report.requirements.met).toBe(true); expect(report.passed).toBe(true);
  });
});

async function corpus(reviewed: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "promptgen-human-eval-")); directories.push(root);
  const directory = path.join(root, "eval", "annotations"); await mkdir(directory, { recursive: true });
  const judgment = (index: number) => ({ reviewerId: "human-1", reviewedAt: "2026-09-05T00:00:00.000Z",
    relevantEvidenceIds: [`e${index}`], forbiddenEvidenceIds: [] });
  const retrieval = Array.from({ length: 150 }, (_, index) => ({ id: `r${index}`, companyId: "co", topic: "topic", variant: "problem",
    query: "buyer query", kinds: ["demand"], accessScopes: ["public"], candidateEvidenceIds: [`e${index}`], rankedEvidenceIds: [`e${index}`],
    status: reviewed && index < 100 ? "reviewed" : "pending", judgments: reviewed && index < 100 ? [judgment(index)] : [] }));
  const grade = { reviewerId: "human-1", reviewedAt: "2026-09-05T00:00:00.000Z", buyerIntent: 5,
    recommendationLikelihood: 5, evidenceEntailment: 5, distinctness: 5, naturalness: 5, accept: true };
  const prompts = Array.from({ length: 200 }, (_, index) => ({ id: `p${index}`, companyId: "co", promptId: `candidate${index}`,
    text: "Which platform should a team evaluate?", evidenceIds: ["e1"], automatedDecision: "accepted", automatedFindings: [],
    status: reviewed ? "reviewed" : "pending", grades: reviewed ? [grade] : [] }));
  await writeFile(path.join(directory, "retrieval.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-09-05T00:00:00.000Z", targetCases: 150, cases: retrieval }));
  await writeFile(path.join(directory, "prompts.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-09-05T00:00:00.000Z", targetCases: 200, cases: prompts }));
  return root;
}
