import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";

const config = await loadConfig();
const directory = path.join(tmpdir(), `promptgen-backup-${crypto.randomUUID()}`);
const destination = path.join(directory, "restored.db");
await mkdir(directory, { recursive: true });
try {
  const source = new Database(config.dbPath, { readonly: true });
  await source.backup(destination);
  const sourceCounts = counts(source); source.close();
  const restored = new Database(destination, { readonly: true });
  const integrity = restored.pragma("integrity_check", { simple: true });
  const restoredCounts = counts(restored); restored.close();
  if (integrity !== "ok" || JSON.stringify(sourceCounts) !== JSON.stringify(restoredCounts)) throw new Error("Backup restore verification failed");
  process.stdout.write(`${JSON.stringify({ integrity, counts: restoredCounts })}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function counts(db: Database.Database): Record<string, number> {
  return Object.fromEntries(["artifacts", "evidence", "runs", "trace_events", "model_cache"].map(table => {
    const row = db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number };
    return [table, row.count];
  }));
}
