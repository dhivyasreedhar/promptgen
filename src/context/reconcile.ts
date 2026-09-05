import type { RankedEvidence, ReconciliationDecision } from "../types.js";
import { tokenize } from "../util.js";

const STOP = new Set(["the", "a", "an", "is", "are", "was", "were", "to", "for", "of", "and", "or", "our", "product", "platform", "currently", "observed", "need", "constraint"]);
const POLARITY = new Set(["not", "no", "never", "cannot", "cant", "unsupported", "without", "longer"]);
const NEGATIVE = /\b(?:does not|do not|cannot|can't|isn't|aren't|unsupported|not available|no longer)\b/i;

export function reconcileRankedEvidence(records: RankedEvidence[]): { records: RankedEvidence[]; decisions: ReconciliationDecision[] } {
  const active = new Map(records.map(record => [record.evidence.id, record]));
  const decisions: ReconciliationDecision[] = [];
  for (let leftIndex = 0; leftIndex < records.length; leftIndex++) {
    const left = records[leftIndex]!;
    if (!active.has(left.evidence.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex++) {
      const right = records[rightIndex]!;
      if (!active.has(right.evidence.id) || !comparable(left, right)) continue;
      const overlap = similarity(left.evidence.claim, right.evidence.claim);
      if (overlap >= 0.78 && polarity(left.evidence.claim) === polarity(right.evidence.claim)) {
        const [winner, loser] = preferred(left, right);
        active.delete(loser.evidence.id);
        winner.reasons.push(`reconciled-duplicate:${loser.evidence.id}`);
        decisions.push({ action: "semantic-duplicate", keptEvidenceId: winner.evidence.id,
          removedEvidenceIds: [loser.evidence.id], reason: "Near-equivalent evidence; retained the fresher, more authoritative record." });
      } else if (overlap >= 0.5 && polarity(left.evidence.claim) !== polarity(right.evidence.claim)) {
        const difference = Math.abs(truthScore(left) - truthScore(right));
        if (difference >= 0.12) {
          const [winner, loser] = preferred(left, right);
          active.delete(loser.evidence.id);
          winner.reasons.push(`reconciled-contradiction:${loser.evidence.id}`);
          decisions.push({ action: "contradiction-resolved", keptEvidenceId: winner.evidence.id,
            removedEvidenceIds: [loser.evidence.id], reason: "Conflicting claims; retained the fresher, more authoritative current record." });
        } else {
          active.delete(left.evidence.id); active.delete(right.evidence.id);
          decisions.push({ action: "contradiction-unresolved", removedEvidenceIds: [left.evidence.id, right.evidence.id],
            reason: "Conflicting claims had comparable authority; neither was allowed to establish current truth." });
          break;
        }
      }
    }
  }
  return { records: records.filter(record => active.has(record.evidence.id)), decisions };
}

function comparable(left: RankedEvidence, right: RankedEvidence): boolean {
  const truthKinds = new Set(["capability", "change"]);
  if (!truthKinds.has(left.evidence.kind) || !truthKinds.has(right.evidence.kind)) return false;
  if (left.evidence.productLine && right.evidence.productLine && left.evidence.productLine !== right.evidence.productLine) return false;
  const leftTags = new Set(left.evidence.tags); const sharedTag = right.evidence.tags.some(tag => leftTags.has(tag));
  return sharedTag || similarity(left.evidence.claim, right.evidence.claim) >= 0.5;
}

function polarity(text: string): 1 | -1 { return NEGATIVE.test(text) ? -1 : 1; }
function terms(text: string): string[] { return tokenize(text).filter(term => !STOP.has(term) && !POLARITY.has(term)); }
function similarity(left: string, right: string): number {
  const a = new Set(terms(left)); const b = new Set(terms(right));
  return [...a].filter(term => b.has(term)).length / Math.max(1, new Set([...a, ...b]).size);
}
function truthScore(record: RankedEvidence): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(record.evidence.occurredAt)) / 86_400_000);
  const current = record.evidence.lifecycle === "confirmed" ? 0.15 : 0;
  return (record.evidence.authority ?? 0.5) * 0.6 + record.evidence.confidence * 0.25 + current + Math.exp(-ageDays / 365) * 0.1;
}
function preferred(left: RankedEvidence, right: RankedEvidence): [RankedEvidence, RankedEvidence] {
  return truthScore(left) >= truthScore(right) ? [left, right] : [right, left];
}
