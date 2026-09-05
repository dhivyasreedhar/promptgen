import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CompanyConfig, Connector, SourceArtifact, SourceType } from "../types.js";

export class FixtureConnector implements Connector {
  constructor(readonly source: SourceType, private readonly fixturesDir: string) {}

  async *collect(company: CompanyConfig, signal: AbortSignal): AsyncIterable<SourceArtifact> {
    const file = path.join(this.fixturesDir, company.id, `${this.source}.jsonl`);
    try { await access(file); } catch { return; }
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (signal.aborted) throw signal.reason;
        if (!line.trim()) continue;
        const value = JSON.parse(line) as SourceArtifact;
        if (value.companyId !== company.id || value.source !== this.source || value.visibility !== "synthetic") {
          throw new Error(`Invalid fixture provenance in ${file}`);
        }
        yield value;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
}
