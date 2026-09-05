import type { CompanyConfig, EvidenceRecord, Opportunity, PromptCandidate, ValidatedCandidate, ValidationFinding } from "../types.js";
import { normalizeText, tokenize } from "../util.js";
import { isEvidenceEligible } from "../context/policy.js";
import { classifyBuyerIntent, isBuyingIntent, isBuyingSignal } from "../context/intent.js";

const SECRET = /(?:sk-[a-z0-9_-]{12,}|api[_ -]?key|bearer\s+[a-z0-9._-]{12,}|password\s*[:=]|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i;
const NAMED_CONSTRAINTS = ["soc 2", "hipaa", "gdpr", "fedramp", "iso 27001", "on-prem", "self-hosted", "gitlab", "github", "jira", "slack"];
const SOLUTION_CUE = /\b(tools?|platforms?|software|solutions?|services?|vendors?|providers?|products?|systems?|apps?|apis?|infrastructure|agents?|reviewers?|alternatives?|replace|switch(?:ing)? to|what should (?:we|i) (?:use|choose|consider)|recommend)\b/i;
const INFORMATIONAL_FRAMING = /^(?:how important is|why is|what is the importance of|what are the benefits of)\b/i;

export function validateCandidates(
  company: CompanyConfig,
  candidates: PromptCandidate[],
  opportunities: Opportunity[],
  evidenceById: Map<string, EvidenceRecord>,
): ValidatedCandidate[] {
  const opportunityById = new Map(opportunities.map(item => [item.id, item]));
  const exactSeen = new Set<string>();
  return candidates.map(candidate => {
    const findings: ValidationFinding[] = [];
    const text = normalizeText(candidate.text);
    const normalized = text.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    const opportunity = opportunityById.get(candidate.opportunityId);
    const records = candidate.evidenceIds.map(id => evidenceById.get(id)).filter((item): item is EvidenceRecord => Boolean(item));
    const candidateIntent = classifyBuyerIntent(text);
    const publicInference = candidate.evidenceBasis === "public-inference";
    const validPublicInference = publicInference && records.length > 0 && records.every(item => item.visibility === "public");

    if (!opportunity) findings.push(fatal("unknown-opportunity", "Candidate references an unknown opportunity."));
    if (records.length < (validPublicInference ? 1 : 2)) findings.push(fatal("weak-provenance", validPublicInference
      ? "A public-inference candidate needs at least one public evidence record."
      : "Candidate needs at least two evidence records."));
    if (records.some(item => !isEvidenceEligible(item))) findings.push(fatal("ineligible-evidence", "Candidate cites expired, restricted, deprecated, planned, or non-exposable evidence."));
    if (!validPublicInference && !records.some(item => ["demand", "language", "constraint", "comparison"].includes(item.kind))) findings.push(fatal("missing-demand", "No buyer-demand evidence supports this prompt."));
    if (!isBuyingIntent(candidateIntent)) findings.push(fatal("not-buying-intent", `Prompt is ${candidateIntent} intent rather than a discovery, evaluation, or purchase situation.`));
    if (INFORMATIONAL_FRAMING.test(text) || !SOLUTION_CUE.test(text)) {
      findings.push(fatal("not-recommendation-seeking", "Prompt is likely to produce advice or explanation rather than a product or vendor recommendation."));
    }
    if (!validPublicInference && !records.some(isBuyingSignal)) {
      findings.push(fatal("missing-buying-demand", "Demand evidence is support, implementation, retention, or operational noise rather than buying intent."));
    }
    if (publicInference && !validPublicInference) findings.push(fatal("invalid-public-inference", "Public-only inference may cite only public evidence."));
    if (!records.some(item => item.kind === "capability" || (item.kind === "change" && item.lifecycle === "confirmed"))) findings.push(fatal("missing-capability", "No confirmed capability evidence supports this prompt."));
    if (text.length < 24 || text.length > 220) findings.push(fatal("length", "Prompt must be between 24 and 220 characters."));
    if (!/[?]$/.test(text)) findings.push(fatal("not-question", "Tracking prompt must be a question."));
    if (/^which\b.{0,100}\b(?:teams?|companies|organizations)\b.{0,80}\b(?:use|uses|rely|choose|adopt)/i.test(text)) {
      findings.push(fatal("audience-as-answer", "Prompt asks for customer examples instead of a recommendable product or workflow."));
    }
    if (SECRET.test(text)) findings.push(fatal("secret-pattern", "Prompt contains a secret or personal-data pattern."));
    if (candidate.archetype !== "boundary" && new RegExp(`\\b${escapeRegExp(company.name)}\\b`, "i").test(text)) {
      findings.push(fatal("brand-leading", "Discovery prompts must not name the tracked company."));
    }
    if (exactSeen.has(normalized)) findings.push(fatal("exact-duplicate", "Duplicate prompt wording."));
    exactSeen.add(normalized);

    const privateQuotes = records.filter(record => record.safeUse !== "public").map(record => record.quote);
    if (privateQuotes.some(quote => sharedPhrase(text, quote, 8))) findings.push(fatal("private-verbatim", "Prompt copies a long phrase from private context."));
    const evidenceText = records.map(record => `${record.claim} ${record.quote} ${record.tags.join(" ").replaceAll("-", " ")}`).join(" ").toLowerCase();
    for (const constraint of NAMED_CONSTRAINTS.filter(value => text.toLowerCase().includes(value))) {
      if (!evidenceText.includes(constraint)) findings.push(fatal("unsupported-named-constraint", `Prompt introduces “${constraint}” without cited evidence.`));
    }

    const topicTerms = opportunity ? tokenize(opportunity.topic.replaceAll("-", " ")) : [];
    const evidenceTerms = new Set(records.flatMap(record => [...record.tags.flatMap(tag => tokenize(tag.replaceAll("-", " "))), ...tokenize(record.claim)]));
    const promptTerms = new Set(tokenize(text));
    const groundingHits = [...new Set([...topicTerms, ...evidenceTerms])].filter(term => promptTerms.has(term)).length;
    if (groundingHits < 1) findings.push(fatal("not-entailed", "Prompt has no lexical grounding in its evidence pack."));

    const sourceCount = new Set(records.map(record => record.source)).size;
    if (sourceCount < 2) findings.push({ code: "single-source", severity: "warning", message: "Prompt is supported by only one source type.", evidenceIds: records.map(record => record.id) });
    const score = Math.max(0, Math.min(1,
      (opportunity?.confidence ?? 0) * 0.45 + Math.min(1, groundingHits / 5) * 0.2 + Math.min(1, sourceCount / 4) * 0.2 +
      (text.length >= 45 && text.length <= 150 ? 0.15 : 0.05) - findings.filter(item => item.severity === "warning").length * 0.04,
    ));
    return { ...candidate, text, accepted: !findings.some(item => item.severity === "fatal"), score, findings };
  });
}

function fatal(code: string, message: string): ValidationFinding { return { code, severity: "fatal", message }; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function sharedPhrase(left: string, right: string, length: number): boolean {
  const a = tokenize(left); const b = tokenize(right); if (a.length < length || b.length < length) return false;
  const phrases = new Set<string>();
  for (let i = 0; i <= b.length - length; i += 1) phrases.add(b.slice(i, i + length).join(" "));
  for (let i = 0; i <= a.length - length; i += 1) if (phrases.has(a.slice(i, i + length).join(" "))) return true;
  return false;
}
