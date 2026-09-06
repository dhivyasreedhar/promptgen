import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { assessRun } from "../src/quality/canary.js";
import { EvidenceDatabase } from "../src/store/database.js";
import type { RunResult } from "../src/types.js";

describe("daily canary", () => {
  it("rejects and hides an incomplete staged prompt set", async () => {
    const file = path.join(tmpdir(), `promptgen-canary-${crypto.randomUUID()}.db`);
    try {
      using db = new EvidenceDatabase(file);
      const run = { schemaVersion: 1 as const, runId: "run-1", companyId: "acme", companyName: "Acme", domain: "acme.test",
        status: "insufficient_evidence" as const, startedAt: "2026-09-06T00:00:00.000Z", completedAt: "2026-09-06T00:01:00.000Z",
        provider: "test", contextMode: "public" as const, discoveryPrompts: [], boundaryPrompts: [], missingEvidence: [],
        metrics: { artifactsIngested: 0, evidenceExtracted: 0, evidenceRetrieved: 0, opportunities: 0, candidatesGenerated: 0, candidatesAccepted: 0 },
        tracePath: "trace.json", warnings: [] } satisfies RunResult;
      db.startRun(run.runId, run.companyId, run.startedAt, false); db.finishRun(run);
      expect(db.latestResults()).toEqual([]);
      const assessment = await assessRun({ dbPath: file } as AppConfig, run);
      expect(assessment.passed).toBe(false);
      expect(assessment.failures.join(" ")).toContain("exactly 10");
    } finally { rmSync(file, { force: true }); rmSync(`${file}-shm`, { force: true }); rmSync(`${file}-wal`, { force: true }); }
  });
});
