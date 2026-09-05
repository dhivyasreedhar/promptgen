import { describe, expect, it } from "vitest";
import { groundEvidenceIds } from "../src/pipeline/run.js";
import type { EvidenceRecord } from "../src/types.js";

function evidence(id: string, kind: EvidenceRecord["kind"], visibility: EvidenceRecord["visibility"] = "synthetic"): EvidenceRecord {
  return { id, companyId: "acme", artifactId: `artifact-${id}`, source: visibility === "public" ? "web" : "gsc",
    visibility, kind, claim: `${kind} schema routing`, quote: `${kind} schema routing`, tags: ["schema-routing"], confidence: 0.9,
    occurredAt: new Date().toISOString(), extractorVersion: "test", safeUse: visibility === "public" ? "public" : "aggregate-only",
    aclScopes: visibility === "public" ? ["public"] : ["company"], lifecycle: "unknown", authority: 0.9, buyerIntent: "evaluation" };
}

describe("candidate evidence grounding", () => {
  it("does not substitute an evaluation constraint for observed demand", () => {
    const demand = evidence("demand", "demand");
    const capability = evidence("capability", "capability", "public");
    const constraint = evidence("constraint", "constraint", "public");
    const byId = new Map([demand, capability, constraint].map(item => [item.id, item]));
    expect(groundEvidenceIds("Which platforms support schema routing?", [demand.id, capability.id], [constraint, capability], byId, "observed-demand"))
      .toEqual([demand.id, capability.id]);
  });

  it("never attaches private context to a public inference", () => {
    const privateDemand = evidence("private-demand", "demand");
    const publicCapability = evidence("public-capability", "capability", "public");
    const byId = new Map([privateDemand, publicCapability].map(item => [item.id, item]));
    expect(groundEvidenceIds("Which platforms support schema routing?", [privateDemand.id, publicCapability.id],
      [privateDemand, publicCapability], byId, "public-inference")).toEqual([publicCapability.id]);
  });
});
