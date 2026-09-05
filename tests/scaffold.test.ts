import { describe, expect, it } from "vitest";
import { scaffoldCandidates } from "../src/prompts/scaffold.js";
import type { CompanyConfig, Opportunity } from "../src/types.js";

const opportunity: Opportunity = {
  id: "opp-1", topic: "complex-pdfs", buyerProblem: "private text must not be copied", segment: "secret customer",
  evidenceIds: ["demand-1", "capability-1"], sources: ["calls", "web"], demandScore: 0.9, capabilityScore: 0.9,
  confidence: 0.9, evidenceBasis: "observed-demand",
};

describe("evidence-derived candidate scaffolds", () => {
  it("creates one conservative, provenance-preserving candidate per opportunity", () => {
    const company: CompanyConfig = { id: "reducto", name: "Reducto", domain: "reducto.ai",
      category: "document intelligence and extraction platform", githubOrganizations: [], enabledSources: [] };
    expect(scaffoldCandidates(company, [opportunity])).toEqual([expect.objectContaining({
      text: "Which document intelligence and extraction platforms are best for complex pdfs?",
      opportunityId: "opp-1", evidenceIds: ["demand-1", "capability-1"], evidenceBasis: "observed-demand",
    })]);
  });

  it("uses a neutral product phrase for an unknown public domain category", () => {
    const company: CompanyConfig = { id: "domain-acme", name: "Acme", domain: "acme.test",
      category: "company or product", githubOrganizations: [], enabledSources: ["web"] };
    expect(scaffoldCandidates(company, [{ ...opportunity, evidenceBasis: "public-inference" }])[0]?.text)
      .toBe("Which software platforms are best for complex pdfs?");
  });
});
