import type { TrackingPrompt, ValidatedCandidate } from "../types.js";
import { tokenize } from "../util.js";

export interface SelectionResult {
  discovery: TrackingPrompt[];
  boundaries: TrackingPrompt[];
}

export function selectPrompts(candidates: ValidatedCandidate[], target = 10, preferredIds = new Set<string>(), benchmarkIds = new Set<string>()): SelectionResult {
  const boundaries = candidates.filter(item => item.accepted && item.archetype === "boundary").sort((a, b) => b.score - a.score).slice(0, 5).map(item => toPrompt(item, benchmarkIds));
  const pool = candidates.filter(item => item.accepted && item.archetype !== "boundary");
  const selected: ValidatedCandidate[] = [];
  const usedOpportunities = new Set<string>();
  const opportunityCounts = new Map<string, number>();
  const usedSemanticKeys = new Set<string>();
  while (selected.length < target && pool.length > 0) {
    let eligible = pool.filter(candidate => !usedOpportunities.has(candidate.opportunityId) &&
      !usedSemanticKeys.has(candidate.semanticKey ?? candidate.opportunityId) && !selected.some(other => conflicts(candidate, other)));
    if (eligible.length === 0) eligible = pool.filter(candidate => (opportunityCounts.get(candidate.opportunityId) ?? 0) < 2 &&
      !usedSemanticKeys.has(candidate.semanticKey ?? candidate.opportunityId) && materiallyDistinctWithinOpportunity(candidate, selected) &&
      !selected.some(other => conflicts(candidate, other)));
    if (eligible.length === 0) break;
    const scored = eligible.map(candidate => {
      const duplicatePenalty = selected.length === 0 ? 0 : Math.max(...selected.map(other => jaccard(candidate.text, other.text))) * 0.45;
      const opportunityBonus = usedOpportunities.has(candidate.opportunityId) ? 0 : 0.18;
      const coverageBonus = coverageNovelty(candidate, selected) * 0.16;
      return { candidate, utility: candidate.score + opportunityBonus +
        coverageBonus + (matches(preferredIds, candidate) ? 0.12 : 0) - duplicatePenalty };
    }).sort((a, b) => b.utility - a.utility);
    const best = scored[0];
    if (!best) break;
    selected.push(best.candidate);
    usedOpportunities.add(best.candidate.opportunityId);
    opportunityCounts.set(best.candidate.opportunityId, (opportunityCounts.get(best.candidate.opportunityId) ?? 0) + 1);
    usedSemanticKeys.add(best.candidate.semanticKey ?? best.candidate.opportunityId);
    pool.splice(pool.indexOf(best.candidate), 1);
  }
  return { discovery: selected.map(item => toPrompt(item, benchmarkIds)), boundaries };
}

function materiallyDistinctWithinOpportunity(candidate: ValidatedCandidate, selected: ValidatedCandidate[]): boolean {
  const peers = selected.filter(item => item.opportunityId === candidate.opportunityId);
  return peers.length === 0 || peers.every(peer => peer.archetype !== candidate.archetype && peer.semanticKey !== candidate.semanticKey);
}

function matches(ids: Set<string>, candidate: ValidatedCandidate): boolean {
  return ids.has(candidate.id) || ids.has(candidate.opportunityId) || Boolean(candidate.semanticKey && ids.has(candidate.semanticKey));
}
function isBenchmark(ids: Set<string>, candidate: ValidatedCandidate): boolean {
  return ids.has(candidate.id) || Boolean(candidate.semanticKey && ids.has(candidate.semanticKey));
}

function coverageNovelty(candidate: ValidatedCandidate, selected: ValidatedCandidate[]): number {
  if (!candidate.coverage || selected.length === 0) return 1;
  const dimensions = ["audience", "useCase", "constraint", "decisionStage"] as const;
  return dimensions.filter(key => !selected.some(item => item.coverage?.[key] === candidate.coverage?.[key])).length / dimensions.length;
}

const COMMON = new Set(["what", "which", "best", "tools", "tool", "platform", "platforms", "team", "teams", "using", "with", "for", "that", "this", "code", "review", "management", "document", "memory", "incident", "artificial", "intelligence"]);
const SEMANTIC_GENERIC = new Set(["supports", "support", "engineering", "organization", "organizations", "our", "need", "needs", "looking", "known", "any", "option", "options", "solution", "solutions", "recommendation"]);

function conflicts(left: ValidatedCandidate, right: ValidatedCandidate): boolean {
  const evidenceOverlap = setJaccard(left.evidenceIds, right.evidenceIds);
  const leftTerms = tokenize(left.text).filter(term => !COMMON.has(term));
  const rightTerms = tokenize(right.text).filter(term => !COMMON.has(term));
  const distinctiveOverlap = setJaccard(leftTerms, rightTerms);
  const semanticLeft = semanticTokens(left.text);
  const semanticRight = semanticTokens(right.text);
  const semanticIntersection = semanticLeft.filter(term => semanticRight.includes(term)).length;
  const semanticOverlap = setJaccard(semanticLeft, semanticRight);
  const keyOverlap = left.semanticKey && right.semanticKey ? setJaccard(keyTokens(left.semanticKey), keyTokens(right.semanticKey)) : 0;
  const sharedNamedFacet = NAMED_FACETS.some(facet => left.text.toLowerCase().includes(facet) && right.text.toLowerCase().includes(facet));
  const sharedConcept = CONCEPTS.some(patterns => patterns.every(pattern => pattern.test(left.text)) && patterns.every(pattern => pattern.test(right.text)));
  return jaccard(left.text, right.text) >= 0.75 ||
    sharedNamedFacet ||
    sharedConcept ||
    keyOverlap >= 0.42 ||
    (semanticIntersection >= 3 && semanticOverlap >= 0.28) ||
    (evidenceOverlap >= 0.3 && distinctiveOverlap >= 0.12);
}

const NAMED_FACETS = ["gitlab", "github", "jira", "slack", "pagerduty", "soc 2", "hipaa", "gdpr", "fedramp", "aws marketplace"];
const CONCEPTS = [
  [/\b(?:ai|artificial intelligence)\b/i, /\bautomat(?:e|es|ed|ing|ion)\b/i],
  [/\bpostmortem|retrospective\b/i, /\baudit|timeline\b/i],
];

const KEY_SYNONYMS: Record<string, string> = {
  search: "retrieval", realtime: "interactive", response: "interactive", speed: "latency", fast: "latency", reducing: "reduce",
  repo: "repository", repos: "repository", monorepo: "repository", monorepos: "repository", retention: "context", preserving: "context",
};
function keyTokens(key: string): string[] {
  return [...new Set(tokenize(key.replaceAll("-", " ")).map(term => KEY_SYNONYMS[term] ?? term))];
}

const SYNONYMS: Record<string, string> = {
  repositories: "repository", repos: "repository", repo: "repository", monorepo: "repository", monorepos: "repository",
  huge: "large", massive: "large", scaling: "large", scaled: "large",
  losing: "lose", loses: "lose", lost: "lose",
  reviews: "review", reviewing: "review", reviewed: "review",
  integrations: "integration", integrates: "integration", integrated: "integration",
  recommendations: "recommendation", vendors: "vendor",
};

function semanticTokens(text: string): string[] {
  return [...new Set(tokenize(text).map(term => SYNONYMS[term] ?? term).filter(term => !COMMON.has(term) && !SEMANTIC_GENERIC.has(term)))];
}

function setJaccard(left: string[], right: string[]): number {
  const a = new Set(left); const b = new Set(right);
  return [...a].filter(value => b.has(value)).length / Math.max(1, new Set([...a, ...b]).size);
}

function toPrompt(candidate: ValidatedCandidate, benchmarkIds = new Set<string>()): TrackingPrompt {
  return { id: candidate.id, text: candidate.text, archetype: candidate.archetype, opportunityId: candidate.opportunityId,
    evidenceIds: candidate.evidenceIds, score: candidate.score, ...(candidate.semanticKey ? { semanticKey: candidate.semanticKey } : {}),
    origin: candidate.origin ?? "inferred-opportunity", coverage: candidate.coverage ?? {
      audience: "general buyer", useCase: candidate.semanticKey?.replaceAll("-", " ") ?? "general evaluation",
      constraint: candidate.archetype === "constraint" ? "stated constraint" : "none stated", decisionStage: "evaluation",
    }, set: isBenchmark(benchmarkIds, candidate) ? "benchmark" : "discovery" };
}

export function summarizeCoverage(prompts: TrackingPrompt[]): { audiences: string[]; useCases: string[]; constraints: string[]; decisionStages: string[]; missing: string[] } {
  const values = <K extends keyof TrackingPrompt["coverage"]>(key: K) => [...new Set(prompts.map(prompt => prompt.coverage[key]))];
  const audiences = values("audience"), useCases = values("useCase"), constraints = values("constraint"), decisionStages = values("decisionStage");
  const missing = [audiences.length < 2 ? "audience diversity" : "", useCases.length < Math.min(6, prompts.length) ? "use-case diversity" : "",
    decisionStages.length < 2 ? "decision-stage diversity" : ""].filter(Boolean);
  return { audiences, useCases, constraints, decisionStages, missing };
}

function jaccard(left: string, right: string): number {
  const a = new Set(tokenize(left)); const b = new Set(tokenize(right));
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}
