import { describe, expect, it } from "vitest";
import { composeTrackingSet } from "../src/prompts/tracking-set.js";
import type { TrackingPrompt } from "../src/types.js";

function prompt(id: string, set: TrackingPrompt["set"] = "discovery", semanticKey = id): TrackingPrompt {
  return { id, semanticKey, text: `Which platform is best for ${id}?`, archetype: "category", opportunityId: id,
    evidenceIds: [], score: 0.8, origin: set === "benchmark" ? "customer-authored" : "inferred-opportunity",
    coverage: { audience: "buyers", useCase: id, constraint: "none stated", decisionStage: "evaluation" }, set };
}

describe("composeTrackingSet", () => {
  it("never returns more than ten prompts when a benchmark is added to ten discoveries", () => {
    const result = composeTrackingSet(Array.from({ length: 10 }, (_, index) => prompt(`d${index}`)), [prompt("b1", "benchmark")]);
    expect(result.benchmarks).toHaveLength(1);
    expect(result.discovery).toHaveLength(9);
    expect(result.benchmarks.length + result.discovery.length).toBe(10);
  });

  it("deduplicates benchmark and discovery prompts by semantic key", () => {
    const result = composeTrackingSet([prompt("d1", "discovery", "shared"), prompt("d2")], [prompt("b1", "benchmark", "shared")]);
    expect(result.benchmarks.length + result.discovery.length).toBe(2);
    expect(result.discovery.map(item => item.id)).toEqual(["d2"]);
  });

  it("caps an oversized benchmark set", () => {
    const result = composeTrackingSet([], Array.from({ length: 12 }, (_, index) => prompt(`b${index}`, "benchmark")));
    expect(result.benchmarks).toHaveLength(10);
  });
});
