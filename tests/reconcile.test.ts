import { describe, expect, it } from "vitest";
import { reconcileRankedEvidence } from "../src/context/reconcile.js";
import type { RankedEvidence } from "../src/types.js";

function ranked(id: string, claim: string, source: RankedEvidence["evidence"]["source"], authority: number, occurredAt: string): RankedEvidence {
  return { score: 1, reasons: [], evidence: { id, companyId: "c", artifactId: `a-${id}`, source, visibility: "public",
    kind: "capability", claim, quote: claim, tags: ["gitlab"], confidence: 0.9, occurredAt, extractorVersion: "test",
    safeUse: "public", lifecycle: "confirmed", authority } };
}

describe("context reconciliation", () => {
  it("removes semantic duplicates while retaining authoritative current evidence", () => {
    const result = reconcileRankedEvidence([
      ranked("docs", "The platform supports private GitLab repositories.", "web", 0.9, "2026-08-01T00:00:00Z"),
      ranked("chat", "Our platform currently supports private GitLab repositories.", "slack", 0.6, "2026-07-01T00:00:00Z"),
    ]);
    expect(result.records.map(item => item.evidence.id)).toEqual(["docs"]);
    expect(result.decisions[0]?.action).toBe("semantic-duplicate");
  });

  it("does not use unresolved contradictory evidence as product truth", () => {
    const result = reconcileRankedEvidence([
      ranked("yes", "The platform supports private GitLab repositories.", "web", 0.86, "2026-08-01T00:00:00Z"),
      ranked("no", "The platform does not support private GitLab repositories.", "github", 0.82, "2026-08-01T00:00:00Z"),
    ]);
    expect(result.records).toHaveLength(0);
    expect(result.decisions[0]?.action).toBe("contradiction-unresolved");
  });
});
