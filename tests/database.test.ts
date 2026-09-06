import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceDatabase } from "../src/store/database.js";
import type { EvidenceRecord, SourceArtifact } from "../src/types.js";

const files: string[] = [];
afterEach(() => { for (const file of files.splice(0)) rmSync(file, { force: true }); });

describe("EvidenceDatabase", () => {
  it("leaves failed extraction pending and invalidates changed content", () => {
    const file = path.join(tmpdir(), `promptgen-${crypto.randomUUID()}.db`); files.push(file, `${file}-shm`, `${file}-wal`);
    using db = new EvidenceDatabase(file);
    const artifact: SourceArtifact = { id: "a1", companyId: "acme", source: "web", externalId: "x", version: "1", occurredAt: new Date().toISOString(), collectedAt: new Date().toISOString(), visibility: "public", title: "x", content: "supported incident coordination workflow", metadata: {} };
    db.upsertArtifact(artifact, "hash-1");
    expect(db.pendingArtifacts("acme", "extractor-1")).toHaveLength(1);
    db.replaceEvidence("a1", "extractor-1", []);
    expect(db.pendingArtifacts("acme", "extractor-1")).toHaveLength(0);
    db.upsertArtifact({ ...artifact, content: "changed" }, "hash-2");
    expect(db.pendingArtifacts("acme", "extractor-1")).toHaveLength(1);
  });

  it("does not silently cap company evidence and persists durable jobs and source health", () => {
    const file = path.join(tmpdir(), `promptgen-${crypto.randomUUID()}.db`); files.push(file, `${file}-shm`, `${file}-wal`);
    using db = new EvidenceDatabase(file);
    const now = "2026-09-04T00:00:00.000Z";
    const artifacts = ["a1", "a2", "a3"].map(id => ({ id, companyId: "acme", source: "web" as const, externalId: id, version: "1", occurredAt: now,
      collectedAt: now, visibility: "public" as const, title: id, content: `The platform supports workflow ${id}.`, metadata: {} }));
    db.upsertArtifacts(artifacts.map(item => ({ artifact: item, contentHash: item.id })));
    db.replaceEvidenceBatch(artifacts.map((item): { artifactId: string; extractorVersion: string; records: EvidenceRecord[] } => ({ artifactId: item.id, extractorVersion: "v1", records: [{
      id: `e-${item.id}`, companyId: "acme", artifactId: item.id, source: "web", visibility: "public", kind: "capability", claim: item.content,
      quote: item.content, tags: [item.id], confidence: 0.8, occurredAt: now, extractorVersion: "v1", safeUse: "public", aclScopes: ["public"], lifecycle: "confirmed", authority: 0.8,
    }] })));
    expect(db.evidenceForCompany("acme")).toHaveLength(3);
    expect(db.evidenceForCompany("acme", 2)).toHaveLength(2);

    db.recordSourceHealth({ companyId: "acme", source: "web", status: "healthy", checkedAt: now, collectedArtifacts: 3, changedArtifacts: 3 });
    expect(db.sourceHealth("acme")[0]?.lastSuccessAt).toBe(now);
    const company = { id: "acme", name: "Acme", domain: "acme.test", category: "tools", githubOrganizations: [], enabledSources: ["web" as const] };
    const queued = db.enqueueJob({ id: "job-1", company, fixtures: false, createdAt: now });
    expect(queued.status).toBe("queued");
    expect(db.claimJob("worker", new Date(now), 60_000)?.status).toBe("running");
    expect(db.renewJobLease("job-1", "worker", new Date(now), 60_000)).toBe(true);
    expect(db.requestJobCancellation("job-1", new Date(now))).toBe(true);
    expect(db.isCancellationRequested("job-1")).toBe(true);
  });

  it("prioritizes interactive public jobs over queued fixture-heavy runs", () => {
    const file = path.join(tmpdir(), `promptgen-${crypto.randomUUID()}.db`); files.push(file, `${file}-shm`, `${file}-wal`);
    using db = new EvidenceDatabase(file);
    const privateCompany = { id: "private", name: "Private", domain: "private.test", category: "tools", githubOrganizations: [], enabledSources: ["web" as const] };
    const publicCompany = { ...privateCompany, id: "public", name: "Public", domain: "public.test" };
    db.enqueueJob({ id: "private-job", company: privateCompany, fixtures: true, createdAt: "2026-09-04T00:00:00.000Z" });
    db.enqueueJob({ id: "public-job", company: publicCompany, fixtures: false, createdAt: "2026-09-04T00:01:00.000Z" });
    expect(db.claimJob("public-worker", new Date("2026-09-04T00:02:00.000Z"), 60_000, true)?.id).toBe("public-job");
    expect(db.claimJob("general-worker", new Date("2026-09-04T00:02:00.000Z"), 60_000)?.id).toBe("private-job");
  });
});
