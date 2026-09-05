import type { EvidenceRecord, Opportunity, ValidatedCandidate } from "../types.js";
import { normalizeText, tokenize } from "../util.js";

export function attachPromptContext(candidates: ValidatedCandidate[], opportunities: Opportunity[], evidence: Map<string, EvidenceRecord>): ValidatedCandidate[] {
  const byOpportunity = new Map(opportunities.map(item => [item.id, item]));
  return candidates.map(candidate => {
    const opportunity = byOpportunity.get(candidate.opportunityId);
    const demand = candidate.evidenceIds.map(id => evidence.get(id)).filter((item): item is EvidenceRecord =>
      Boolean(item && (item.kind === "demand" || item.kind === "language")));
    return { ...candidate, origin: candidate.evidenceBasis === "public-inference" ? "inferred-opportunity" : originFor(candidate.text, demand), coverage: opportunity?.coverage ?? {
      audience: "general buyer", useCase: candidate.semanticKey?.replaceAll("-", " ") ?? "general evaluation",
      constraint: candidate.archetype === "constraint" ? "stated constraint" : "none stated", decisionStage: "evaluation",
    } };
  });
}

function originFor(prompt: string, demand: EvidenceRecord[]): NonNullable<ValidatedCandidate["origin"]> {
  const normalized = normalizeText(prompt).toLowerCase().replaceAll(/[^a-z0-9 ]/g, "");
  if (demand.some(record => normalizeText(record.quote).toLowerCase().replaceAll(/[^a-z0-9 ]/g, "") === normalized)) return "observed-question";
  const promptTerms = new Set(tokenize(prompt));
  const directlyAdapted = demand.some(record => {
    const terms = tokenize(record.quote);
    return terms.filter(term => promptTerms.has(term)).length / Math.max(1, new Set(terms).size) >= 0.35;
  });
  return directlyAdapted ? "adapted-from-evidence" : "inferred-opportunity";
}
