import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { rerankFrozenRetrievalCorpus, type LlmJudgeReport } from "../eval-llm-judge.js";

interface Baseline {
  schemaVersion: 1;
  approvedAt: string;
  provider: string;
  metrics: {
    uniqueClaimRecallAt12: number;
    precisionAt12: number;
    forbiddenHitRate: number;
    acceptedPromptRate: number;
    rejectedPromptRate: number;
    recommendationLikelihood: number;
    evidenceEntailment: number;
  };
}

export interface ReleaseGateReport {
  passed: boolean;
  baselineProvider: string;
  currentProvider: string;
  failures: string[];
  warnings: string[];
  metrics: Baseline["metrics"];
}

/** Machine-only deployment gate. Safety/count failures are absolute; quality uses bounded baseline drift. */
export async function evaluateReleaseGate(config: AppConfig): Promise<ReleaseGateReport> {
  const baseline = JSON.parse(await readFile(path.join(config.rootDir, "eval", "machine-baseline.json"), "utf8")) as Baseline;
  return compareReleaseQuality(await rerankFrozenRetrievalCorpus(config), baseline);
}

export function compareReleaseQuality(current: LlmJudgeReport, baseline: Baseline): ReleaseGateReport {
  const failures: string[] = [], warnings: string[] = [];
  const metrics = {
    uniqueClaimRecallAt12: current.retrieval.uniqueClaimRecallAt12,
    precisionAt12: current.retrieval.precisionAt12,
    forbiddenHitRate: current.retrieval.forbiddenHitRate,
    acceptedPromptRate: current.prompts.pipelineAccepted.judgeAcceptanceRate,
    rejectedPromptRate: current.prompts.pipelineRejected.judgeAcceptanceRate,
    recommendationLikelihood: current.prompts.pipelineAccepted.averageRecommendationLikelihood,
    evidenceEntailment: current.prompts.pipelineAccepted.averageEvidenceEntailment,
  };
  if (current.retrieval.total !== 150 || current.retrieval.twiceJudged !== 150) failures.push(`retrieval suite incomplete: ${current.retrieval.twiceJudged}/150 twice judged`);
  if (current.prompts.total !== 200 || current.prompts.twiceJudged !== 200) failures.push(`prompt suite incomplete: ${current.prompts.twiceJudged}/200 twice judged`);
  if (metrics.forbiddenHitRate > 0) failures.push(`forbidden evidence appeared in ranked results (${metrics.forbiddenHitRate})`);
  regression(failures, "unique claim recall@12", metrics.uniqueClaimRecallAt12, baseline.metrics.uniqueClaimRecallAt12, 0.03);
  regression(failures, "precision@12", metrics.precisionAt12, baseline.metrics.precisionAt12, 0.03);
  regression(failures, "accepted prompt judge rate", metrics.acceptedPromptRate, baseline.metrics.acceptedPromptRate, 0.05);
  regression(failures, "recommendation likelihood", metrics.recommendationLikelihood, baseline.metrics.recommendationLikelihood, 0.15);
  regression(failures, "evidence entailment", metrics.evidenceEntailment, baseline.metrics.evidenceEntailment, 0.15);
  if (metrics.acceptedPromptRate - metrics.rejectedPromptRate < 0.05) failures.push("validator separation fell below 5 percentage points");
  if (current.provider !== baseline.provider) warnings.push(`judge provider changed from ${baseline.provider} to ${current.provider}; refresh the baseline only after a successful comparison run`);
  return { passed: failures.length === 0, baselineProvider: baseline.provider, currentProvider: current.provider, failures, warnings, metrics };
}

function regression(failures: string[], name: string, current: number, baseline: number, tolerance: number): void {
  if (current < baseline - tolerance) failures.push(`${name} regressed from ${round(baseline)} to ${round(current)} (allowed drop ${tolerance})`);
}
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
