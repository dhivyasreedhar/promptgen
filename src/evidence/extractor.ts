import type { EvidenceKind, EvidenceRecord, SourceArtifact } from "../types.js";
import { normalizeText, stableId } from "../util.js";
import { authorityFor, lifecycleFrom, scopesFrom } from "../context/policy.js";
import { classifyBuyerIntent } from "../context/intent.js";

export const EXTRACTOR_VERSION = "evidence-v1.3.0-intent";

const DEMAND_SOURCES = new Set(["gsc", "slack", "intercom", "crm", "calls", "mintlify", "github"]);
// Capability is an assertion about what exists, not the presence of a product
// noun. This distinction prevents customer requests from becoming fake features.
const CAPABILITY_PATTERNS = /\b(shipped|released|launched|implemented|enabled|added|built|supports|provides?|offers?|includes?|integrates?|available)\b|\b(?:we|our product|the product|the platform|the api|the system|the tool) support\b/i;
const DEMAND_PATTERNS = /\b(need|needs|want|wants|struggle|problem|fails?|difficult|slow|cannot|can't|search query|evaluating|requirement|criterion|because)\b/i;
const CONSTRAINT_PATTERNS = /\b(limit|constraint|cannot|does not|unsupported|private|security|compliance|residency|latency|large|complex|sensitive)\b/i;
const CHANGE_PATTERNS = /\b(shipped|released|deprecated|planned|investigating|changelog|version)\b/i;
const SECRET_PATTERNS = /(?:sk-[a-z0-9_-]{12,}|api[_ -]?key\s*[:=]|bearer\s+[a-z0-9._-]{12,}|password\s*[:=])/i;
const PII_PATTERNS = /(?:[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d[\d ()-]{8,}\d)/i;

export class EvidenceExtractor {
  readonly version = EXTRACTOR_VERSION;

  extract(artifact: SourceArtifact): EvidenceRecord[] {
    const labels = labelsFrom(artifact.metadata);
    const sentences = splitSentences(artifact.content).slice(0, artifact.source === "web" ? 60 : 12);
    const output: EvidenceRecord[] = [];
    for (const [index, sentence] of sentences.entries()) {
      const lifecycle = lifecycleFrom(sentence, artifact.metadata);
      const kinds = classify(sentence, artifact.source, lifecycle);
      for (const kind of kinds) {
        const claim = normalizeClaim(sentence, kind);
        if (claim.length < 24 || claim.length > 700) continue;
        output.push({
          id: stableId(artifact.id, this.version, String(index), kind), companyId: artifact.companyId,
          artifactId: artifact.id, source: artifact.source, visibility: artifact.visibility, kind,
          claim, quote: sentence, tags: labels, confidence: confidenceFor(artifact, sentence, kind),
          occurredAt: artifact.occurredAt, extractorVersion: this.version,
          safeUse: safeUseFor(artifact, sentence),
          aclScopes: scopesFrom(artifact.visibility, artifact.metadata), lifecycle,
          authority: authorityFor(artifact.source),
          ...(typeof artifact.metadata.validFrom === "string" ? { validFrom: artifact.metadata.validFrom } : {}),
          ...(typeof artifact.metadata.validTo === "string" ? { validTo: artifact.metadata.validTo } : {}),
          ...(typeof artifact.metadata.segment === "string" ? { segment: artifact.metadata.segment } : {}),
          buyerIntent: classifyBuyerIntent(sentence),
        });
      }
    }
    return dedupe(output);
  }
}

function safeUseFor(artifact: SourceArtifact, sentence: string): EvidenceRecord["safeUse"] {
  if (artifact.metadata.neverExpose === true || SECRET_PATTERNS.test(sentence)) return "never-expose";
  if (artifact.visibility === "public") return "public";
  if (artifact.source === "gsc" || artifact.source === "mintlify") return "aggregate-only";
  if (PII_PATTERNS.test(sentence)) return "derive-only";
  return "derive-only";
}

function classify(sentence: string, source: SourceArtifact["source"], lifecycle: EvidenceRecord["lifecycle"]): EvidenceKind[] {
  const kinds = new Set<EvidenceKind>();
  if (DEMAND_SOURCES.has(source) && DEMAND_PATTERNS.test(sentence)) kinds.add("demand");
  if (source === "gsc" && /\b(search query|impressions|clicks|average position)\b/i.test(sentence)) kinds.add("demand");
  if (source === "mintlify" && /\b(documentation analytics|visitors|views|searches|search)\b/i.test(sentence)) kinds.add("demand");
  if (CAPABILITY_PATTERNS.test(sentence) && source !== "gsc" && lifecycle !== "planned" && lifecycle !== "investigating" && lifecycle !== "deprecated" && lifecycle !== "superseded") kinds.add("capability");
  if (CONSTRAINT_PATTERNS.test(sentence)) kinds.add("constraint");
  if (CHANGE_PATTERNS.test(sentence)) kinds.add("change");
  if (/\b(alternative|versus|vs\.?|replace|migration|evaluating vendors?)\b/i.test(sentence)) kinds.add("comparison");
  if ((source === "slack" || source === "intercom" || source === "calls") && sentence.includes('"')) kinds.add("language");
  return [...kinds];
}

function labelsFrom(metadata: Record<string, unknown>): string[] {
  const labels = Array.isArray(metadata.labels) ? metadata.labels.filter((x): x is string => typeof x === "string") : [];
  return [...new Set(labels.map(value => value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-")).filter(Boolean))];
}

function splitSentences(content: string): string[] {
  return normalizeText(content).split(/(?<=[.!?])\s+|\n+/).map(normalizeText).filter(value => value.length >= 20);
}

function normalizeClaim(sentence: string, kind: EvidenceKind): string {
  const prefix = kind === "demand" ? "Observed need: " : kind === "constraint" ? "Constraint: " : "";
  return `${prefix}${sentence}`;
}

function confidenceFor(artifact: SourceArtifact, sentence: string, kind: EvidenceKind): number {
  let score = artifact.visibility === "public" ? 0.72 : 0.65;
  if (kind === "demand" && artifact.source === "gsc") score += 0.2;
  if (kind === "capability" && artifact.source === "web") score += 0.15;
  if (sentence.length > 50) score += 0.05;
  return Math.min(0.98, score);
}

function dedupe(records: EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter(record => {
    const key = `${record.kind}:${record.claim.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
