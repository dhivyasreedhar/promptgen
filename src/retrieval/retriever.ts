import type { EvidenceDatabase } from "../store/database.js";
import type { AccessContext, EvidenceNeed, EvidencePack, EvidenceRecord, RankedEvidence, SourceHealth, SourceType } from "../types.js";
import { tokenize } from "../util.js";
import { DEFAULT_ACCESS, freshnessHalfLifeDays, isEvidenceEligible } from "../context/policy.js";
import { reconcileRankedEvidence } from "../context/reconcile.js";

const EXPANSIONS: Record<string, string[]> = {
  secure: ["security", "compliance", "private"], security: ["secure", "compliance"],
  fast: ["latency", "speed", "quick"], latency: ["fast", "performance"],
  migrate: ["migration", "replace", "switch"], migration: ["migrate", "replace"],
  reliable: ["reliability", "retries", "errors"], reliability: ["reliable", "retries"],
  integrate: ["integration", "connect"], integration: ["integrate", "connect"],
  large: ["scale", "enterprise", "batch"], scale: ["large", "enterprise", "batch"],
};

export class EvidenceRetriever {
  constructor(private readonly db: EvidenceDatabase) {}

  retrieve(companyId: string, needs: EvidenceNeed[], perNeed = 12, access: AccessContext = DEFAULT_ACCESS): EvidencePack[] {
    const health = new Map(this.db.sourceHealth(companyId).map(item => [item.source, item]));
    return needs.map(need => {
      const originalTerms = tokenize(need.query);
      const queryTerms = expandTerms(originalTerms);
      const matches = [...new Map(need.kinds.flatMap(kind => this.db.searchEvidence(companyId, queryTerms, perNeed * 5, kind))
        .map(match => [match.record.id, match])).values()];
      const ranked = matches
        .filter(({ record }) => need.kinds.includes(record.kind) && isEvidenceEligible(record, access) && relevanceGate(record, originalTerms, queryTerms))
        .map(({ record, lexicalRank }) => scoreRecord(record, need, lexicalRank, queryTerms, health.get(record.source)))
        .sort((a, b) => b.score - a.score);
      const reconciled = reconcileRankedEvidence(ranked);
      const records = diversify(reconciled.records, need, perNeed);
      return { need, records, missing: records.length < 2, reconciliation: reconciled.decisions };
    });
  }
}

function scoreRecord(record: EvidenceRecord, need: EvidenceNeed, lexicalRank: number, queryTerms: string[], health?: SourceHealth): RankedEvidence {
  const reasons: string[] = [];
  const recordTerms = new Set(tokenize(`${record.claim} ${record.quote} ${record.tags.join(" ").replaceAll("-", " ")}`));
  const semanticCoverage = queryTerms.filter(term => recordTerms.has(term)).length / Math.max(1, queryTerms.length);
  let score = record.confidence * 0.65 + 1 / (1 + lexicalRank * 0.15) * 0.55 + semanticCoverage * 0.6;
  reasons.push(`query-coverage:${semanticCoverage.toFixed(2)}`);
  if (need.preferredSources.includes(record.source)) { score += 0.3; reasons.push("preferred-source"); }
  if (record.kind === "demand") { score += 0.15; reasons.push("demand-evidence"); }
  if (record.visibility === "public") { score += 0.1; reasons.push("publicly-verifiable"); }
  const ageDays = Math.max(0, (Date.now() - Date.parse(record.occurredAt)) / 86_400_000);
  const freshness = Math.pow(0.5, ageDays / freshnessHalfLifeDays(record.source));
  score += freshness * 0.2;
  const authority = record.authority ?? 0.5;
  score += authority * 0.25;
  if (health?.status === "degraded") { score -= 0.35; reasons.push("source-health:degraded"); }
  else if (health?.status === "empty") { score -= 0.2; reasons.push("source-health:empty"); }
  else if (health?.status === "healthy") reasons.push("source-health:healthy");
  reasons.push(`authority:${authority.toFixed(2)}`, `freshness:${freshness.toFixed(2)}`, `lexical-rank:${lexicalRank}`);
  return { evidence: record, score, reasons };
}

function expandTerms(terms: string[]): string[] {
  return [...new Set(terms.flatMap(term => [term, ...(EXPANSIONS[term] ?? [])]))].slice(0, 12);
}

function relevanceGate(record: EvidenceRecord, originalTerms: string[], expandedTerms: string[]): boolean {
  const recordTerms = new Set(tokenize(`${record.claim} ${record.quote}`));
  const originalCoverage = originalTerms.filter(term => recordTerms.has(term)).length / Math.max(1, originalTerms.length);
  const tags = new Set(record.tags.flatMap(tag => tokenize(tag.replaceAll("-", " "))));
  const expandedTagHit = expandedTerms.some(term => tags.has(term));
  return originalCoverage >= 0.3 || expandedTagHit;
}

function diversify(records: RankedEvidence[], need: EvidenceNeed, limit: number): RankedEvidence[] {
  const selected: RankedEvidence[] = [];
  const sourceCounts = new Map<SourceType, number>();
  for (const kind of need.kinds) {
    const item = records.find(candidate => candidate.evidence.kind === kind && !selected.includes(candidate));
    if (item) {
      selected.push(item);
      sourceCounts.set(item.evidence.source, (sourceCounts.get(item.evidence.source) ?? 0) + 1);
    }
  }
  for (const item of records) {
    if (selected.includes(item)) continue;
    const count = sourceCounts.get(item.evidence.source) ?? 0;
    if (count >= Math.max(2, Math.ceil(limit / 3))) continue;
    selected.push(item);
    sourceCounts.set(item.evidence.source, count + 1);
    if (selected.length === limit) break;
  }
  return selected;
}
