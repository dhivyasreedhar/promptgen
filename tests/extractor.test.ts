import { describe, expect, it } from "vitest";
import { EvidenceExtractor } from "../src/evidence/extractor.js";
import type { SourceArtifact, SourceType } from "../src/types.js";

function artifact(source: SourceType, content: string): SourceArtifact {
  return {
    id: `${source}-1`, companyId: "example", source, externalId: "1", version: "1",
    occurredAt: "2026-01-01T00:00:00.000Z", collectedAt: "2026-01-01T00:00:00.000Z",
    visibility: "synthetic", title: "test", content, metadata: { labels: ["memory"] },
  };
}

describe("EvidenceExtractor role integrity", () => {
  it("does not turn a customer requirement into product capability", () => {
    const records = new EvidenceExtractor().extract(artifact("intercom", "Support request: customer requirement for agent attribution in multi-agent memory."));
    expect(records.map(item => item.kind)).toContain("demand");
    expect(records.map(item => item.kind)).not.toContain("capability");
  });

  it("recognizes an affirmative shipped capability", () => {
    const records = new EvidenceExtractor().extract(artifact("linear", "Shipped: shared application memory with agent attribution."));
    expect(records.map(item => item.kind)).toContain("capability");
    expect(records.map(item => item.kind)).toContain("change");
  });

  it("recognizes product-action language on a public web page without applying it to private requests", () => {
    const web = { ...artifact("web", "Monitor production errors and trace slow requests across your application."), visibility: "public" as const,
      url: "https://example.com/product/error-monitoring/" };
    expect(new EvidenceExtractor().extract(web).map(item => item.kind)).toContain("capability");
    expect(new EvidenceExtractor().extract(artifact("intercom", "We need a vendor that monitors production errors across our application."))
      .map(item => item.kind)).not.toContain("capability");
  });

  it("does not treat public navigation and demo calls to action as capabilities", () => {
    const web = { ...artifact("web", "Explore cookbook docs and request a free demo to get started."), visibility: "public" as const,
      url: "https://example.com/product/error-monitoring/" };
    expect(new EvidenceExtractor().extract(web).map(item => item.kind)).not.toContain("capability");
  });

  it("keeps planned work out of the capability role", () => {
    const records = new EvidenceExtractor().extract(artifact("linear", "Planned: the platform will support air-gapped deployments."));
    expect(records.map(item => item.kind)).toContain("change");
    expect(records.map(item => item.kind)).not.toContain("capability");
    expect(records.every(item => item.lifecycle === "planned")).toBe(true);
  });

  it("does not promote arbitrary records based only on their connector", () => {
    expect(new EvidenceExtractor().extract(artifact("gsc", "Internal test record created during onboarding."))).toEqual([]);
    expect(new EvidenceExtractor().extract(artifact("mintlify", "Automated notification: workflow completed successfully."))).toEqual([]);
    expect(new EvidenceExtractor().extract(artifact("linear", "Weekly planning notes and scheduling updates."))).toEqual([]);
  });

  it("marks sentence-level credentials as never exposable", () => {
    const records = new EvidenceExtractor().extract(artifact("intercom", "Customer needs help because bearer abcdefghijklmnop was pasted into a support request."));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(item => item.safeUse === "never-expose")).toBe(true);
  });
});
