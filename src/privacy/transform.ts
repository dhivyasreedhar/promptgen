import type { EvidenceRecord } from "../types.js";
import { hash } from "../util.js";

export interface ExternalEvidence {
  id: string;
  kind: EvidenceRecord["kind"];
  source: EvidenceRecord["source"];
  lifecycle?: EvidenceRecord["lifecycle"];
  buyerIntent?: EvidenceRecord["buyerIntent"];
  safeSummary: string;
  tags: string[];
}

export interface PrivacyTransformation {
  evidenceId: string;
  policy: EvidenceRecord["safeUse"];
  inputHash: string;
  outputHash: string;
  rules: string[];
  safePreview: string;
}

const SAFE_TOKEN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const IDENTIFIER = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d ()-]{8,}\d|https?:\/\/\S+|\b(?:sk|pk|api)[-_][a-z0-9_-]{8,}\b|\b[A-Z]{2,8}-\d{2,8}\b)/gi;
const QUOTED = /["“][^"”]{2,}["”]/g;
const NUMBER = /\b\d+(?:[.,]\d+)?%?\b/g;

export function transformEvidenceForExternal(record: EvidenceRecord): { evidence?: ExternalEvidence; audit: PrivacyTransformation } {
  if (record.safeUse === "never-expose") {
    return { audit: audit(record, "", ["blocked-never-expose"]) };
  }
  if (record.safeUse === "public") {
    const safeSummary = redactPublicAccidents(record.claim);
    return { evidence: base(record, safeSummary), audit: audit(record, safeSummary, safeSummary === record.claim ? ["public-pass-through"] : ["public-secret-redaction"]) };
  }
  const tags = record.tags.filter(tag => SAFE_TOKEN.test(tag)).slice(0, 12);
  const intent = record.buyerIntent ?? "unknown";
  const topic = tags.length ? tags.join(", ") : "the documented product category";
  const safeSummary = record.safeUse === "aggregate-only"
    ? `Aggregated ${record.source} ${record.kind} signal about ${topic}; buyer intent: ${intent}.`
    : `De-identified ${record.source} ${record.kind} signal about ${topic}; buyer intent: ${intent}.`;
  return { evidence: { ...base(record, safeSummary), tags }, audit: audit(record, safeSummary,
    [record.safeUse === "aggregate-only" ? "aggregate-only-summary" : "derive-only-taxonomy", "removed-free-text", "removed-identifiers", "removed-names", "removed-metrics"]) };
}

export function safePreviewForUi(record: EvidenceRecord): { text: string; rules: string[] } {
  const transformed = transformEvidenceForExternal(record);
  return { text: transformed.audit.safePreview, rules: transformed.audit.rules };
}

export function redactedEvidenceExcerptForUi(record: EvidenceRecord): { text: string; rules: string[] } {
  if (record.safeUse === "never-expose") return { text: "Withheld by source policy.", rules: ["blocked-never-expose"] };
  if (record.safeUse === "aggregate-only") return { text: transformEvidenceForExternal(record).audit.safePreview, rules: ["aggregate-only-summary"] };
  if (record.safeUse === "public") return { text: record.quote, rules: ["public-source"] };
  const text = record.quote
    .replace(IDENTIFIER, "[identifier]")
    .replace(/\b(?:project|customer|account|workspace)\s+[A-Z0-9][A-Za-z0-9_-]{2,}\b/g, "$1 [private]")
    .replace(/\b[A-Z][a-z]{2,}\s+(?:at|from)\s+[A-Z][A-Za-z0-9_-]+\b/g, "[person] at [company]")
    .replace(/\b[A-Z]{3,}[A-Z0-9_-]*\b/g, "[private]")
    .replace(NUMBER, "[number]");
  return { text, rules: ["redacted-identifiers", "redacted-names", "redacted-internal-entities", "redacted-metrics"] };
}

function base(record: EvidenceRecord, safeSummary: string): ExternalEvidence {
  return { id: record.id, kind: record.kind, source: record.source, lifecycle: record.lifecycle,
    buyerIntent: record.buyerIntent, safeSummary, tags: record.tags.filter(tag => SAFE_TOKEN.test(tag)).slice(0, 12) };
}

function audit(record: EvidenceRecord, output: string, rules: string[]): PrivacyTransformation {
  return { evidenceId: record.id, policy: record.safeUse, inputHash: hash(record.claim), outputHash: hash(output),
    rules, safePreview: output || "Withheld from external models." };
}

function redactPublicAccidents(value: string): string {
  return value.replace(IDENTIFIER, "[redacted]").replace(QUOTED, "[quoted text]").replace(NUMBER, match => match.length > 3 ? "[number]" : match);
}
