import { describe, expect, it } from "vitest";
import type { LlmJudgeReport } from "../src/eval-llm-judge.js";
import { compareReleaseQuality } from "../src/quality/release-gate.js";

const baseline = { schemaVersion: 1 as const, approvedAt: "2026-09-06T00:00:00.000Z", provider: "openai:test", metrics: {
  uniqueClaimRecallAt12: 0.75, precisionAt12: 0.4, forbiddenHitRate: 0, acceptedPromptRate: 0.78,
  rejectedPromptRate: 0.66, recommendationLikelihood: 4.1, evidenceEntailment: 3.9,
} };

function report(): LlmJudgeReport { return { provider: "openai:test", retrieval: { total: 150, twiceJudged: 150, agreement: 0.7,
  poolRecordRecallAt12: 0.3, uniqueClaimRecallAt12: 0.75, precisionAt12: 0.4, forbiddenHitRate: 0, flaggedForHuman: [] },
  prompts: { total: 200, twiceJudged: 200, pipelineAccepted: { total: 90, judgeAcceptanceRate: 0.78, averageBuyerIntent: 4.3,
    averageRecommendationLikelihood: 4.1, averageEvidenceEntailment: 3.9, averageDistinctness: 4.1, averageNaturalness: 4.7 },
  pipelineRejected: { total: 110, judgeAcceptanceRate: 0.66, averageBuyerIntent: 4.4, averageRecommendationLikelihood: 4,
    averageEvidenceEntailment: 3.8, averageDistinctness: 4, averageNaturalness: 4.8 }, flaggedForHuman: [] } }; }

describe("machine release gate", () => {
  it("passes a complete non-regressing suite", () => expect(compareReleaseQuality(report(), baseline).passed).toBe(true));
  it("blocks privacy failures and material regressions", () => {
    const current = report(); current.retrieval.forbiddenHitRate = 0.01; current.retrieval.uniqueClaimRecallAt12 = 0.6;
    const result = compareReleaseQuality(current, baseline);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("forbidden evidence");
    expect(result.failures.join(" ")).toContain("unique claim recall");
  });
});
