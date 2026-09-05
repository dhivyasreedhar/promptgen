import { describe, expect, it } from "vitest";
import { redactedEvidenceExcerptForUi, safeEmbeddingText, transformEvidenceForExternal } from "../src/privacy/transform.js";
import type { EvidenceRecord } from "../src/types.js";

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { id: "e1", companyId: "c", artifactId: "a", source: "slack", visibility: "private", kind: "demand",
    claim: "Alice at Acme said alice@example.com needs Project ORBIT for 42 seats", quote: "Alice at Acme said alice@example.com needs Project ORBIT for 42 seats",
    tags: ["enterprise-security"], confidence: 0.8, occurredAt: new Date().toISOString(), extractorVersion: "v", safeUse: "derive-only",
    buyerIntent: "evaluation", ...overrides };
}

describe("external-model privacy boundary", () => {
  it("never sends private free text, identifiers, names, projects, or metrics", () => {
    const result = transformEvidenceForExternal(record());
    const payload = JSON.stringify(result.evidence);
    expect(payload).not.toMatch(/Alice|Acme|example\.com|ORBIT|42/);
    expect(payload).toContain("enterprise-security");
    expect(result.audit.rules).toContain("removed-free-text");
  });

  it("blocks never-expose evidence", () => {
    expect(transformEvidenceForExternal(record({ safeUse: "never-expose" })).evidence).toBeUndefined();
  });

  it("shows customers a useful excerpt with private entities removed", () => {
    const excerpt = redactedEvidenceExcerptForUi(record()).text;
    expect(excerpt).toContain("needs");
    expect(excerpt).not.toMatch(/Alice|Acme|example\.com|ORBIT|42/);
  });

  it("embeds only the authorized private abstraction", () => {
    const text = safeEmbeddingText(record());
    expect(text).toContain("enterprise-security");
    expect(text).not.toMatch(/Alice|Acme|example\.com|ORBIT|42/);
  });

  it("redacts accidental identifiers before embedding public claims", () => {
    const text = safeEmbeddingText(record({ visibility: "public", safeUse: "public", claim: "Contact alice@example.com about API key sk-secretsecret123" }));
    expect(text).not.toMatch(/alice@example\.com|sk-secretsecret123/);
  });
});
