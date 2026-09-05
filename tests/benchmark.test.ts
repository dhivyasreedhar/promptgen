import { describe, expect, it } from "vitest";
import path from "node:path";
import { evaluateIndependentBenchmark } from "../src/eval-benchmark.js";
import type { AppConfig } from "../src/config.js";

describe("independent adversarial retrieval benchmark", () => {
  it("finds labeled evidence without leaking forbidden records", async () => {
    const rootDir = path.resolve(import.meta.dirname, "..");
    const report = await evaluateIndependentBenchmark({ rootDir } as AppConfig);
    expect(report.expectedRecallAt12).toBe(1);
    expect(report.expectedRecallAt3).toBe(1);
    expect(report.meanReciprocalRank).toBe(1);
    expect(report.precisionAt12).toBe(1);
    expect(report.forbiddenHitRate).toBe(0);
    expect(report.accessLeakageRate).toBe(0);
    expect(report.staleTruthLeakageRate).toBe(0);
    expect(report.passed).toBe(true);
  });
});
