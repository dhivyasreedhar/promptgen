import type { EvidenceDatabase } from "../store/database.js";
import type { AccessContext, EvidenceNeed, EvidencePack, EvidenceRecord, RankedEvidence, SourceHealth, SourceType } from "../types.js";
import { tokenize } from "../util.js";
import { DEFAULT_ACCESS, freshnessHalfLifeDays, isEvidenceEligible } from "../context/policy.js";
import { reconcileRankedEvidence } from "../context/reconcile.js";

const EXPANSIONS: Record<string, string[]> = {
  secure: ["security", "compliance", "private"], security: ["secure", "compliance"],
  fast: ["faster", "slow", "latency", "speed", "quick"], latency: ["fast", "faster", "slow", "performance"],
  migrate: ["migration", "replace", "switch"], migration: ["migrate", "replace"],
  reliable: ["reliability", "retries", "errors"], reliability: ["reliable", "retries"],
  integrate: ["integration", "connect"], integration: ["integrate", "connect"],
  large: ["scale", "enterprise", "batch"], scale: ["large", "enterprise", "batch"],
  scales: ["scale", "scaling", "large"], scaling: ["scale", "large", "performance"],
  monorepos: ["monorepo", "large"], monorepo: ["monorepos", "large"],
  replays: ["replay", "session"], debugging: ["debug", "errors"],
  cross: ["multi"], "cross-team": ["cross", "multi", "multi-team", "team"], outages: ["outage", "incident"], outage: ["outages", "incident"],
  processing: ["ingestion", "process"], ingestion: ["processing", "ingest"],
};
const QUERY_STOP = new Set(["best", "which", "what", "tools", "tool", "products", "product", "platforms", "platform", "support", "supports", "customer", "customers", "problem", "need", "needs", "evaluating", "evaluation", "selection", "solution", "solutions", "using", "with", "that", "from", "into", "their", "your", "company", "companies", "software", "service", "services", "system", "systems", "agent", "agents", "api", "apis", "infrastructure", "work", "incident", "response", "document", "memory", "management", "code", "review", "reviews", "repository", "repositories", "repo", "ai"]);
const LOW_INTENT = new Set(["support", "implementation", "retention", "irrelevant"]);

export class EvidenceRetriever {
  constructor(private readonly db: EvidenceDatabase) {}

  retrieve(companyId: string, needs: EvidenceNeed[], perNeed = 12, access: AccessContext = DEFAULT_ACCESS): EvidencePack[] {
    const health = new Map(this.db.sourceHealth(companyId).map(item => [item.source, item]));
    return needs.map(need => {
      const originalTerms = tokenize(need.query);
      const queryTerms = expandTerms(originalTerms);
      const matches = [...new Map(need.kinds.flatMap(kind => this.db.searchEvidence(companyId, queryTerms, perNeed * 5, kind))
        .map(match => [match.record.id, match])).values()];
      const selected = rankCandidatePool(matches, need, perNeed, access, health);
      return { need, records: selected.records, missing: selected.records.length < 2, reconciliation: selected.reconciliation };
    });
  }
}

export function rankCandidatePool(matches: Array<{ record: EvidenceRecord; lexicalRank: number }>, need: EvidenceNeed, limit: number,
  access: AccessContext = DEFAULT_ACCESS, health = new Map<SourceType, SourceHealth>(), nowMs = Date.now()): { records: RankedEvidence[]; reconciliation: ReturnType<typeof reconcileRankedEvidence>["decisions"] } {
  const reconciled = reconcileRankedEvidence(rankEvidenceCandidates(matches, need, access, health, nowMs));
  return { records: diversify(reconciled.records, limit), reconciliation: reconciled.decisions };
}

export function rankEvidenceCandidates(matches: Array<{ record: EvidenceRecord; lexicalRank: number }>, need: EvidenceNeed,
  access: AccessContext = DEFAULT_ACCESS, health = new Map<SourceType, SourceHealth>(), nowMs = Date.now()): RankedEvidence[] {
  const originalTerms = tokenize(need.query);
  const queryTerms = expandTerms(originalTerms);
  const coreTerms = coreQueryTerms(originalTerms);
  return matches
    .filter(({ record }) => need.kinds.includes(record.kind) && isEvidenceEligible(record, access))
    .map(({ record, lexicalRank }) => {
      const ranked = scoreRecord(record, need, lexicalRank, queryTerms, coreTerms, health.get(record.source), nowMs);
      if (!relevanceGate(record, originalTerms, queryTerms, coreTerms)) { ranked.score -= 0.85; ranked.reasons.push("weak-core-match"); }
      return ranked;
    })
    .sort((a, b) => b.score - a.score || b.evidence.authority! - a.evidence.authority! || a.evidence.id.localeCompare(b.evidence.id));
}

function scoreRecord(record: EvidenceRecord, need: EvidenceNeed, lexicalRank: number, queryTerms: string[], coreTerms: string[], health: SourceHealth | undefined, nowMs: number): RankedEvidence {
  const reasons: string[] = [];
  const recordTerms = new Set(tokenize(`${record.claim} ${record.quote} ${record.tags.join(" ").replaceAll("-", " ")}`));
  const semanticCoverage = queryTerms.filter(term => recordTerms.has(term)).length / Math.max(1, queryTerms.length);
  const coreCoverage = coreTerms.filter(term => recordTerms.has(term)).length / Math.max(1, coreTerms.length);
  const phraseCoverage = adjacentCoverage(coreTerms, recordTerms);
  let score = record.confidence * 0.45 + 1 / (1 + lexicalRank * 0.15) * 0.3 + semanticCoverage * 0.45 + coreCoverage * 1.5 + phraseCoverage * 0.35;
  reasons.push(`query-coverage:${semanticCoverage.toFixed(2)}`);
  reasons.push(`core-coverage:${coreCoverage.toFixed(2)}`);
  if (need.preferredSources.includes(record.source)) { score += 0.12; reasons.push("preferred-source"); }
  if (record.kind === "demand" && !LOW_INTENT.has(record.buyerIntent ?? "")) { score += 0.12; reasons.push("buying-demand"); }
  if ((record.kind === "demand" || record.kind === "language" || record.kind === "comparison") && record.buyerIntent && LOW_INTENT.has(record.buyerIntent)) { score -= 0.55; reasons.push(`low-intent:${record.buyerIntent}`); }
  if (record.claim.length > 500 || /Products Pricing Docs Community Company/i.test(record.claim)) { score -= 0.38; reasons.push("boilerplate-penalty"); }
  if (record.visibility === "public") { score += 0.1; reasons.push("publicly-verifiable"); }
  const ageDays = Math.max(0, (nowMs - Date.parse(record.occurredAt)) / 86_400_000);
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

function relevanceGate(record: EvidenceRecord, originalTerms: string[], expandedTerms: string[], coreTerms: string[]): boolean {
  const recordTerms = new Set(tokenize(`${record.claim} ${record.quote}`));
  const originalCoverage = originalTerms.filter(term => recordTerms.has(term)).length / Math.max(1, originalTerms.length);
  const tags = new Set(record.tags.flatMap(tag => tokenize(tag.replaceAll("-", " "))));
  const expandedTagHit = expandedTerms.some(term => tags.has(term));
  const coreHits = coreTerms.filter(term => [term, ...(EXPANSIONS[term] ?? [])].some(candidate => recordTerms.has(candidate) || tags.has(candidate))).length;
  const coreCoverage = coreHits / Math.max(1, coreTerms.length);
  if (coreTerms.length > 0) {
    const minimumCoreHits = Math.min(2, coreTerms.length);
    return coreHits >= minimumCoreHits && (coreCoverage >= 0.2 || expandedTagHit);
  }
  return originalCoverage >= 0.3 || expandedTagHit;
}

function diversify(records: RankedEvidence[], limit: number): RankedEvidence[] {
  const deduplicated = semanticDedupe(records);
  const strong = deduplicated.filter(item => !item.reasons.includes("weak-core-match"));
  // A sparse result is more honest than filling context with unrelated records.
  // Downstream selection already has an explicit insufficient-evidence state.
  const eligible = strong;
  const selected: RankedEvidence[] = [];
  const sourceCounts = new Map<SourceType, number>();
  const kindCounts = new Map<EvidenceRecord["kind"], number>();
  const topWindow = Math.min(12, limit);
  const availableSources = new Set(eligible.map(item => item.evidence.source)).size;
  const sourceCap = Math.max(2, Math.ceil(topWindow / Math.max(1, Math.min(4, availableSources))));
  while (selected.length < topWindow) {
    const candidates = eligible.filter(item => !selected.includes(item) && (sourceCounts.get(item.evidence.source) ?? 0) < sourceCap);
    if (!candidates.length) break;
    const item = [...candidates].sort((left, right) => adjustedScore(right, selected, kindCounts) - adjustedScore(left, selected, kindCounts))[0]!;
    selected.push(item); sourceCounts.set(item.evidence.source, (sourceCounts.get(item.evidence.source) ?? 0) + 1);
    kindCounts.set(item.evidence.kind, (kindCounts.get(item.evidence.kind) ?? 0) + 1);
  }
  for (const item of eligible) {
    if (selected.length >= limit) break;
    if (selected.includes(item)) continue;
    const count = sourceCounts.get(item.evidence.source) ?? 0;
    selected.push(item);
    sourceCounts.set(item.evidence.source, count + 1);
  }
  return selected;
}

function coreQueryTerms(terms: string[]): string[] { const core = terms.filter(term => !QUERY_STOP.has(term)); return core.length ? core : terms; }
function adjacentCoverage(terms: string[], recordTerms: Set<string>): number { if (terms.length < 2) return 0; let hits = 0; for (let index = 0; index < terms.length - 1; index++) if (recordTerms.has(terms[index]!) && recordTerms.has(terms[index + 1]!)) hits++; return hits / (terms.length - 1); }
function normalizedTerms(record: RankedEvidence): Set<string> { return new Set(tokenize(record.evidence.claim).filter(term => !QUERY_STOP.has(term))); }
function overlap(left: Set<string>, right: Set<string>): number { return [...left].filter(term => right.has(term)).length / Math.max(1, new Set([...left, ...right]).size); }
function semanticDedupe(records: RankedEvidence[]): RankedEvidence[] {
  const selected: RankedEvidence[] = [];
  for (const item of records) {
    const terms = normalizedTerms(item);
    if (selected.some(existing => existing.evidence.kind === item.evidence.kind && overlap(terms, normalizedTerms(existing)) >= 0.95)) {
      const winner = selected.find(existing => existing.evidence.kind === item.evidence.kind && overlap(terms, normalizedTerms(existing)) >= 0.95);
      winner?.reasons.push(`suppressed-duplicate:${item.evidence.id}`); continue;
    }
    selected.push(item);
  }
  return selected;
}
function adjustedScore(item: RankedEvidence, selected: RankedEvidence[], kindCounts: Map<EvidenceRecord["kind"], number>): number {
  const novelty = selected.length ? Math.max(...selected.map(existing => overlap(normalizedTerms(item), normalizedTerms(existing)))) : 0;
  const kindBonus = (kindCounts.get(item.evidence.kind) ?? 0) === 0 ? 0.08 : 0;
  return item.score + kindBonus - novelty * 0.55;
}
