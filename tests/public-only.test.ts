import { describe, expect, it } from "vitest";
import { discoverOpportunities } from "../src/opportunities/discover.js";
import { validateCandidates } from "../src/prompts/validate.js";
import { rankPublicUrls } from "../src/connectors/web.js";
import type { CompanyConfig, EvidencePack, EvidenceRecord, PromptCandidate } from "../src/types.js";

const company: CompanyConfig = { id: "public-co", name: "Public Co", domain: "public.co", category: "product analytics", githubOrganizations: [], enabledSources: ["web"] };
const publicCapability = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: "capability-1", companyId: company.id, artifactId: "page-1", source: "web", visibility: "public",
  kind: "capability", claim: "The platform provides privacy-friendly product analytics and session replay",
  quote: "Privacy-friendly product analytics and session replay are available", tags: ["product-analytics"],
  confidence: 0.9, occurredAt: new Date().toISOString(), extractorVersion: "test", safeUse: "public",
  lifecycle: "confirmed", buyerIntent: "irrelevant", ...overrides,
});

describe("public-only prompt path", () => {
  it("creates a conservative inferred opportunity from current public capability evidence", () => {
    const evidence = publicCapability();
    const packs: EvidencePack[] = [{
      need: { id: "topic:product-analytics", query: "privacy product analytics", kinds: ["capability", "constraint"], reason: "test", preferredSources: ["web"] },
      records: [{ evidence, score: 1, reasons: ["public"] }], missing: true,
    }];
    const opportunities = discoverOpportunities(company.id, packs);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.evidenceBasis).toBe("public-inference");
    expect(opportunities[0]?.coverage?.decisionStage).toBe("evaluation");
  });

  it("accepts a buying-intent prompt grounded in one public capability without pretending demand was observed", () => {
    const evidence = publicCapability();
    const opportunity = discoverOpportunities(company.id, [{
      need: { id: "topic:product-analytics", query: "privacy product analytics", kinds: ["capability"], reason: "test", preferredSources: ["web"] },
      records: [{ evidence, score: 1, reasons: [] }], missing: true,
    }])[0]!;
    const candidate: PromptCandidate = {
      id: "candidate-1", opportunityId: opportunity.id,
      text: "Which product analytics platforms support privacy-friendly session replay?", archetype: "constraint",
      evidenceIds: [evidence.id], evidenceBasis: "public-inference", version: 1,
    };
    const result = validateCandidates(company, [candidate], [opportunity], new Map([[evidence.id, evidence]]))[0]!;
    expect(result.accepted).toBe(true);
    expect(result.findings.map(item => item.code)).not.toContain("missing-demand");
  });

  it("does not allow private evidence to bypass observed-demand validation", () => {
    const evidence = publicCapability({ visibility: "private", safeUse: "derive-only" });
    const candidate: PromptCandidate = {
      id: "candidate-1", opportunityId: "opportunity-1", text: "Which product analytics platforms support session replay?",
      archetype: "category", evidenceIds: [evidence.id], evidenceBasis: "public-inference", version: 1,
    };
    const result = validateCandidates(company, [candidate], [{ id: "opportunity-1", topic: "product-analytics", buyerProblem: "analytics",
      segment: "product teams", evidenceIds: [evidence.id], sources: ["web"], demandScore: 0.2, capabilityScore: 0.8,
      confidence: 0.6, evidenceBasis: "public-inference" }], new Map([[evidence.id, evidence]]))[0]!;
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("invalid-public-inference");
  });

  it("ranks core product pages ahead of handbook and blog pages", () => {
    const ranked = rankPublicUrls([
      "https://example.com/handbook/product/onboarding",
      "https://example.com/blog/product-update",
      "https://example.com/product/analytics",
      "https://example.com/pricing",
      "https://example.com/",
    ]);
    expect(ranked.slice(0, 3)).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
      "https://example.com/product/analytics",
    ]);
  });
});
