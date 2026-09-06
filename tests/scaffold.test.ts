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
      text: "Which document intelligence and extraction platforms should buyers evaluate for complex pdfs?",
      opportunityId: "opp-1", evidenceIds: ["demand-1", "capability-1"], evidenceBasis: "observed-demand",
    })]);
  });

  it("uses a neutral product phrase for an unknown public domain category", () => {
    const company: CompanyConfig = { id: "domain-acme", name: "Acme", domain: "acme.test",
      category: "company or product", githubOrganizations: [], enabledSources: ["web"] };
    expect(scaffoldCandidates(company, [{ ...opportunity, evidenceBasis: "public-inference" }])[0]?.text)
      .toBe("Which software platforms should buyers evaluate for complex pdfs?");
  });

  it("turns comparison topic labels into natural buyer questions", () => {
    const company: CompanyConfig = { id: "reducto", name: "Reducto", domain: "reducto.ai",
      category: "document intelligence and extraction platform", githubOrganizations: [], enabledSources: [] };
    const candidates = scaffoldCandidates(company, [
      { ...opportunity, id: "opp-vs", topic: "vs-llamaparse" },
      { ...opportunity, id: "opp-comparison", topic: "document-ai-platform-comparison" },
    ]);
    expect(candidates.map(item => item.text)).toEqual([
      "What are the best alternatives to Llamaparse among document intelligence and extraction platforms?",
      "Which document intelligence and extraction platforms should buyers compare?",
    ]);
    expect(candidates.every(item => !/best for (?:vs|.*platform comparison)/i.test(item.text))).toBe(true);
  });

  it("turns descriptive infrastructure categories into a grammatical product phrase", () => {
    const company: CompanyConfig = { id: "supermemory", name: "Supermemory", domain: "supermemory.ai",
      category: "memory infrastructure for AI applications", githubOrganizations: [], enabledSources: [] };
    expect(scaffoldCandidates(company, [{ ...opportunity, topic: "edge-and-global-latency-reliability" }])[0]?.text)
      .toBe("Which AI application memory platforms should buyers evaluate for edge and global latency reliability?");
  });

  it("does not turn customer-list retrieval labels into prompts", () => {
    const company: CompanyConfig = { id: "domain-atlassian", name: "Atlassian", domain: "atlassian.com",
      category: "company or product", githubOrganizations: [], enabledSources: ["web"] };
    expect(scaffoldCandidates(company, [{ ...opportunity, topic: "customers-mercedes-benz-jira" }])).toEqual([]);
  });
});
