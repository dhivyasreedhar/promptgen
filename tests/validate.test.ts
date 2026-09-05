import { describe, expect, it } from "vitest";
import { validateCandidates } from "../src/prompts/validate.js";
import type { CompanyConfig, EvidenceRecord, Opportunity, PromptCandidate } from "../src/types.js";

const company: CompanyConfig = { id: "acme", name: "Acme", domain: "acme.test", category: "incident platform", githubOrganizations: [], enabledSources: [] };
const baseEvidence = (overrides: Partial<EvidenceRecord>): EvidenceRecord => ({ id: "e1", companyId: "acme", artifactId: "a1", source: "gsc", visibility: "synthetic", kind: "demand", claim: "Observed need for incident coordination in Slack", quote: "search query incident coordination slack", tags: ["slack-incidents"], confidence: .9, occurredAt: new Date().toISOString(), extractorVersion: "v1", safeUse: "aggregate-only", ...overrides });
const opportunity: Opportunity = { id: "o1", topic: "slack-incidents", buyerProblem: "incident coordination", segment: "SRE teams", evidenceIds: ["e1", "e2"], sources: ["gsc", "web"], demandScore: .9, capabilityScore: .8, confidence: .9 };

function validate(text: string, evidence: EvidenceRecord[]) {
  const candidate: PromptCandidate = { id: "c1", opportunityId: "o1", text, archetype: "category", evidenceIds: evidence.map(item => item.id), version: 1 };
  return validateCandidates(company, [candidate], [opportunity], new Map(evidence.map(item => [item.id, item])))[0]!;
}

describe("validateCandidates", () => {
  it("accepts a grounded, unbranded prompt with demand and capability evidence", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Slack incident coordination workflows are supported", quote: "Slack incident coordination workflows" })];
    expect(validate("What are the best platforms for coordinating incidents in Slack?", evidence).accepted).toBe(true);
  });

  it("rejects private verbatim disclosure", () => {
    const privateQuote = "our confidential customer needs incident coordination with special atlas release procedures every Friday";
    const evidence = [baseEvidence({ quote: privateQuote, safeUse: "derive-only" }), baseEvidence({ id: "e2", kind: "capability", source: "web", visibility: "public", safeUse: "public" })];
    const result = validate(`What platform helps ${privateQuote}?`, evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("private-verbatim");
  });

  it("rejects a named compliance standard absent from cited evidence", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Review activity can be audited", quote: "auditable review activity" })];
    const result = validate("Which incident platforms provide SOC 2 compliance and Slack coordination?", evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("unsupported-named-constraint");
  });

  it("rejects questions whose requested answer is a list of customers", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Security teams use incident coordination workflows", quote: "Security teams use incident coordination workflows" })];
    const result = validate("Which security teams rely on incident coordination platforms?", evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("audience-as-answer");
  });

  it("rejects support questions even when capability evidence is present", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Account password reset is supported", quote: "Account password reset" })];
    const result = validate("How do I reset my incident platform password?", evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("not-buying-intent");
  });

  it("rejects informational questions that are unlikely to produce a product recommendation", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Native Jira incident integration is available", quote: "Native Jira incident integration" })];
    const result = validate("How important is native Jira integration when choosing an incident platform?", evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("not-recommendation-seeking");
  });

  it("rejects workflow advice without a product or solution cue", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Slack incident status updates are supported", quote: "Slack incident status updates" })];
    const result = validate("What's the best way to send incident status updates directly from Slack?", evidence);
    expect(result.accepted).toBe(false);
    expect(result.findings.map(item => item.code)).toContain("not-recommendation-seeking");
  });

  it("accepts an explicit product-evaluation form of the same need", () => {
    const evidence = [baseEvidence({}), baseEvidence({ id: "e2", source: "web", visibility: "public", safeUse: "public", kind: "capability", claim: "Incident platforms support Slack status updates", quote: "Incident platforms support Slack status updates" })];
    expect(validate("Which incident platforms send status updates directly from Slack?", evidence).accepted).toBe(true);
  });
});
