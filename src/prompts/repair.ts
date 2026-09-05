import type { EvidenceRecord, Opportunity, PromptCandidate } from "../types.js";
import { stableId } from "../util.js";

export interface CandidateRepair {
  originalId: string;
  repaired: PromptCandidate;
  changes: string[];
}

export function repairCandidates(
  candidates: PromptCandidate[],
  opportunities: Opportunity[],
  evidenceById: Map<string, EvidenceRecord>,
): CandidateRepair[] {
  const opportunityById = new Map(opportunities.map(item => [item.id, item]));
  return candidates.map(candidate => {
    const opportunity = opportunityById.get(candidate.opportunityId);
    const changes: string[] = [];
    let text = candidate.text.trim();
    if (!text.endsWith("?")) {
      text = `${text.replace(/[.!]+$/, "")} — what options should we consider?`;
      changes.push("question-form");
    }
    // A rewrite may normalize wording, but it must never manufacture provenance by
    // attaching a merely adjacent record. Missing evidence is a rejection condition.
    const evidenceIds = [...new Set(candidate.evidenceIds.filter(id => opportunity?.evidenceIds.includes(id) && evidenceById.has(id)))].slice(0, 8);
    if (evidenceIds.length !== candidate.evidenceIds.length) changes.push("invalid-evidence-removed");
    if (changes.length === 0) return { originalId: candidate.id, repaired: candidate, changes };
    return {
      originalId: candidate.id,
      repaired: {
        ...candidate, id: stableId(candidate.id, "repair", text, evidenceIds.join(",")), text, evidenceIds,
        version: candidate.version + 1, parentId: candidate.id,
      },
      changes,
    };
  });
}
