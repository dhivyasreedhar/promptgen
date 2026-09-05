import { describe, expect, it } from "vitest";
import { isEvidenceEligible, lifecycleFrom } from "../src/context/policy.js";
import type { EvidenceRecord } from "../src/types.js";

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id: "e1", companyId: "acme", artifactId: "a1", source: "web", visibility: "public", kind: "capability",
    claim: "The platform supports private deployment.", quote: "The platform supports private deployment.", tags: ["deployment"],
    confidence: 0.8, occurredAt: "2026-01-01T00:00:00.000Z", extractorVersion: "test", safeUse: "public",
    lifecycle: "confirmed", authority: 0.8, aclScopes: ["public"], ...overrides };
}

describe("context eligibility policy", () => {
  it("distinguishes roadmap language from confirmed truth", () => {
    expect(lifecycleFrom("Investigating support for air-gapped deployments.", {})).toBe("investigating");
    expect(lifecycleFrom("The product currently supports air-gapped deployments.", {})).toBe("confirmed");
  });

  it("rejects planned, expired, restricted, and never-expose evidence", () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    expect(isEvidenceEligible(evidence({ lifecycle: "planned" }), { scopes: ["public", "company"] }, now)).toBe(false);
    expect(isEvidenceEligible(evidence({ validTo: "2026-01-01T00:00:00.000Z" }), { scopes: ["public"] }, now)).toBe(false);
    expect(isEvidenceEligible(evidence({ aclScopes: ["security-team"] }), { scopes: ["public", "company"] }, now)).toBe(false);
    expect(isEvidenceEligible(evidence({ safeUse: "never-expose" }), { scopes: ["public"] }, now)).toBe(false);
  });
});
