import type { AccessContext, EvidenceLifecycle, EvidenceRecord, SourceType } from "../types.js";

const SOURCE_AUTHORITY: Record<SourceType, number> = {
  web: 0.86,
  github: 0.82,
  gsc: 0.96,
  calls: 0.9,
  crm: 0.84,
  intercom: 0.82,
  mintlify: 0.8,
  linear: 0.76,
  slack: 0.62,
};

export const DEFAULT_ACCESS: AccessContext = { scopes: ["public", "company"] };

export function authorityFor(source: SourceType): number {
  return SOURCE_AUTHORITY[source];
}

export function lifecycleFrom(text: string, metadata: Record<string, unknown>): EvidenceLifecycle {
  const explicit = metadata.lifecycle;
  if (explicit === "confirmed" || explicit === "planned" || explicit === "investigating" || explicit === "deprecated" || explicit === "superseded" || explicit === "unknown") return explicit;
  if (/\b(deprecated|sunset|removed|no longer supported)\b/i.test(text)) return "deprecated";
  if (/\b(superseded|replaced by)\b/i.test(text)) return "superseded";
  if (/\b(investigating|exploring|considering)\b/i.test(text)) return "investigating";
  if (/\b(planned|roadmap|coming soon|will support)\b/i.test(text)) return "planned";
  if (/\b(shipped|released|launched|implemented|enabled|added|available|currently supports?)\b/i.test(text)) return "confirmed";
  return "unknown";
}

export function scopesFrom(visibility: EvidenceRecord["visibility"], metadata: Record<string, unknown>): string[] {
  const explicit = Array.isArray(metadata.aclScopes)
    ? metadata.aclScopes.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];
  return visibility === "public" ? ["public"] : ["company"];
}

export function isEvidenceEligible(record: EvidenceRecord, access: AccessContext = DEFAULT_ACCESS, now = new Date()): boolean {
  if (record.safeUse === "never-expose") return false;
  const scopes = record.aclScopes?.length ? record.aclScopes : record.visibility === "public" ? ["public"] : ["company"];
  if (!scopes.some(scope => access.scopes.includes(scope))) return false;
  if (record.validFrom && Date.parse(record.validFrom) > now.getTime()) return false;
  if (record.validTo && Date.parse(record.validTo) <= now.getTime()) return false;
  if (record.lifecycle === "deprecated" || record.lifecycle === "superseded") return false;
  if ((record.kind === "capability" || record.kind === "change") && (record.lifecycle === "planned" || record.lifecycle === "investigating")) return false;
  return true;
}

export function freshnessHalfLifeDays(source: SourceType): number {
  if (source === "gsc" || source === "mintlify") return 90;
  if (source === "slack" || source === "intercom" || source === "calls" || source === "crm") return 180;
  if (source === "linear" || source === "github") return 270;
  return 365;
}
