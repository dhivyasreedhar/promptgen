import { createHash, randomUUID } from "node:crypto";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 24);
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic RFC 4122 UUID used to map stable local identifiers into Postgres UUID keys. */
export function stableUuid(...parts: string[]): string {
  const bytes = Buffer.from(createHash("sha256").update(parts.join("\u001f")).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newRunId(companyId: string, now = new Date()): string {
  return `${companyId}-${now.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function tokenize(input: string): string[] {
  return [...new Set(input.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? [])];
}

export function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: isoNow(), level, event, ...data })}\n`);
}
