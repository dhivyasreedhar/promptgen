import { describe, expect, it } from "vitest";
import { rankCandidatePool } from "../src/retrieval/retriever.js";
import type { EvidenceNeed, EvidenceRecord, SourceType } from "../src/types.js";

const need: EvidenceNeed = { id: "large", query: "AI code review tool that scales to large monorepos and repositories",
  kinds: ["demand", "capability", "constraint", "language", "comparison"], reason: "test", preferredSources: [] };

function evidence(id: string, claim: string, source: SourceType = "web", kind: EvidenceRecord["kind"] = "capability",
  buyerIntent: EvidenceRecord["buyerIntent"] = "evaluation"): EvidenceRecord {
  return { id, companyId: "acme", artifactId: `artifact-${id}`, source, visibility: source === "web" ? "public" : "synthetic",
    kind, claim, quote: claim, tags: claim.toLowerCase().split(/\W+/).filter(Boolean), confidence: 0.9,
    occurredAt: "2026-09-01T00:00:00Z", extractorVersion: "test", safeUse: source === "web" ? "public" : "derive-only",
    aclScopes: [source === "web" ? "public" : "company"], lifecycle: "confirmed", authority: 0.85, buyerIntent };
}

describe("retrieval ranking", () => {
  it("prioritizes discriminating query terms and suppresses duplicate claims", () => {
    const records = [
      evidence("gitlab", "AI code review integrates with private GitLab repositories."),
      evidence("large", "Repository-wide context handles very large monorepos without losing dependencies."),
      evidence("duplicate-a", "Teams need repository-wide context for very large monorepos.", "gsc", "demand"),
      evidence("duplicate-b", "Teams need repository-wide context for very large monorepos.", "calls", "demand"),
    ];
    const result = rankCandidatePool(records.map((record, index) => ({ record, lexicalRank: index + 1 })), need, 12);
    expect(result.records[0]?.evidence.id).toBe("large");
    expect(result.records.filter(item => item.evidence.id.startsWith("duplicate"))).toHaveLength(1);
    expect(result.records.findIndex(item => item.evidence.id === "gitlab")).toBe(-1);
  });

  it("keeps low-intent support noise below buying demand", () => {
    const records = [
      evidence("support", "How do I configure a large monorepo?", "intercom", "demand", "support"),
      evidence("buyer", "Evaluating vendors that understand dependencies across large monorepos.", "crm", "demand", "evaluation"),
    ];
    const result = rankCandidatePool(records.map((record, index) => ({ record, lexicalRank: index + 1 })), need, 12);
    expect(result.records.map(item => item.evidence.id)).toEqual(["buyer", "support"]);
  });

  it("caps a single source at three records inside the top window when alternatives exist", () => {
    const features = ["dependency graphs", "audit trails", "merge queues", "context windows", "ownership maps", "security scans", "custom policies", "review latency"];
    const workflows = ["stacked changes", "legacy migrations", "polyglot services", "release trains", "branch protections"];
    const conversations = ["platform adoption", "vendor migration", "developer trust", "enterprise rollout"];
    const records = features.map((feature, index) => evidence(`gsc-${index}`, `Large monorepo requirement involving ${feature}`, "gsc", "demand"))
      .concat(workflows.map((workflow, index) => evidence(`web-${index}`, `Large monorepo capability for ${workflow}`, "web", "capability")))
      .concat(conversations.map((conversation, index) => evidence(`calls-${index}`, `Large monorepo evaluation about ${conversation}`, "calls", "language")));
    const result = rankCandidatePool(records.map((record, index) => ({ record, lexicalRank: index + 1 })), need, 12);
    const firstTwelve = result.records.slice(0, 12);
    expect(firstTwelve.filter(item => item.evidence.source === "gsc").length).toBeLessThanOrEqual(4);
    expect(new Set(firstTwelve.map(item => item.evidence.source)).size).toBeGreaterThanOrEqual(3);
    expect(result.records).toHaveLength(12);
  });
});
