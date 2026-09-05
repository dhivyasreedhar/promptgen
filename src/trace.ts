import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceDatabase } from "./store/database.js";
import type { TraceEvent } from "./types.js";
import { isoNow } from "./util.js";

export class TraceRecorder {
  constructor(private readonly db: EvidenceDatabase, readonly runId: string, readonly companyId: string) {}

  record(stage: string, action: string, data: Record<string, unknown>, subjectId?: string): void {
    const event: TraceEvent = {
      at: isoNow(), runId: this.runId, companyId: this.companyId, stage, action, data,
      ...(subjectId ? { subjectId } : {}),
    };
    this.db.appendTrace(event);
  }

  async writeManifest(runDirectory: string): Promise<string> {
    await mkdir(runDirectory, { recursive: true });
    const tracePath = path.join(runDirectory, "trace.json");
    await writeFile(tracePath, `${JSON.stringify(this.db.traceForRun(this.runId), null, 2)}\n`, "utf8");
    return tracePath;
  }
}
