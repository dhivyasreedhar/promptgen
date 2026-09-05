import { describe, expect, it } from "vitest";
import { applyPromptGuidance } from "../src/pipeline/run.js";
import type { ValidatedCandidate } from "../src/types.js";

const base: ValidatedCandidate = { id: "c1", opportunityId: "o1", text: "Which tools work for enterprise teams?", archetype: "category",
  evidenceIds: ["d", "c"], version: 1, accepted: true, score: .9, findings: [], semanticKey: "enterprise-tools",
  origin: "inferred-opportunity", coverage: { audience: "enterprise teams", useCase: "review", constraint: "none stated", decisionStage: "evaluation" } };

describe("set-level feedback", () => {
  it("applies a wrong-audience correction to every matching candidate", () => {
    const candidates = [base, { ...base, id: "c2", opportunityId: "o2", semanticKey: "enterprise-security" },
      { ...base, id: "c3", opportunityId: "o3", semanticKey: "startup-tools", coverage: { ...base.coverage!, audience: "startups" } }];
    const result = applyPromptGuidance(candidates, new Set(), [{ reason: "wrong-audience", dimension: "audience", value: "enterprise teams" }]);
    expect(result.filter(item => !item.accepted)).toHaveLength(2);
    expect(result[2]?.accepted).toBe(true);
  });
});
