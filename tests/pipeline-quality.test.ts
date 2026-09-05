import { describe, expect, it } from "vitest";
import { applyModelReviews, publicOpportunities } from "../src/pipeline/run.js";
import { selectPrompts } from "../src/prompts/select.js";
import type { CompanyConfig, EvidenceRecord, ValidatedCandidate } from "../src/types.js";

const company: CompanyConfig = {
  id: "acme", name: "Acme", domain: "acme.test", category: "developer tools", githubOrganizations: [], enabledSources: ["web"],
};

function capability(id: string, claim: string): EvidenceRecord {
  return { id, companyId: company.id, artifactId: `a-${id}`, source: "web", visibility: "public", kind: "capability",
    claim, quote: claim, tags: [], confidence: 0.9, occurredAt: new Date().toISOString(), extractorVersion: "test",
    safeUse: "public", lifecycle: "confirmed", authority: 0.86 };
}

function candidate(index: number, useCase: string): ValidatedCandidate {
  return { id: `c${index}`, opportunityId: `o${index}`, text: `Which tools support ${useCase} for software teams?`, archetype: "category",
    evidenceIds: [`e${index}`], version: 1, evidenceBasis: "public-inference", accepted: true, score: 0.8, findings: [],
    coverage: { audience: "software teams", useCase, constraint: "none stated", decisionStage: "evaluation" } };
}

describe("pipeline quality gates", () => {
  it("fails a candidate when any material clause is unsupported", () => {
    const evidence = capability("e1", "The product supports SSO and SAML.");
    const reviewed = applyModelReviews([candidate(1, "enterprise access")], new Map([["c1", {
      candidateId: "c1", supported: true, demandSupported: false, capabilitySupported: true, relevantEvidenceIds: ["e1"],
      usable: true, semanticKey: "enterprise-access", score: 0.8, findings: [], unsupportedClaims: ["SCIM and audit logs"],
    }]]), new Map([[evidence.id, evidence]]));
    expect(reviewed[0]?.accepted).toBe(false);
    expect(reviewed[0]?.findings.map(item => item.code)).toContain("atomic-claim-unsupported");
  });

  it("requires eight distinct buying situations before using variations", () => {
    const situations = ["repository scale", "security policies", "review latency", "legacy migration", "audit records", "developer adoption", "polyglot projects"];
    const candidates = Array.from({ length: 10 }, (_, index) => candidate(index, situations[index % situations.length]!));
    expect(selectPrompts(candidates, 10).discovery).toHaveLength(7);
  });

  it("builds public fast-path opportunities without a model planning round", () => {
    const opportunities = publicOpportunities(company, [
      capability("e1", "The product supports repository-wide code review context."),
      capability("e2", "The product provides configurable security policies."),
    ]);
    expect(opportunities).toHaveLength(2);
    expect(opportunities.every(item => item.evidenceBasis === "public-inference")).toBe(true);
    expect(opportunities.flatMap(item => item.evidenceIds)).toEqual(expect.arrayContaining(["e1", "e2"]));
  });
});
