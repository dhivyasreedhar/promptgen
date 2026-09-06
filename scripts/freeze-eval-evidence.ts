import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { transformEvidenceForExternal } from "../src/privacy/transform.js";
import { EvidenceDatabase } from "../src/store/database.js";
import type { EvidenceRecord } from "../src/types.js";

try { process.loadEnvFile(); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
const config = await loadConfig();
const directory = path.join(config.rootDir, "eval", "annotations");
const retrieval = JSON.parse(await readFile(path.join(directory, "retrieval.json"), "utf8")) as { cases: Array<{ candidateEvidenceIds: string[] }> };
const ids = [...new Set(retrieval.cases.flatMap(item => item.candidateEvidenceIds))];
const sourcePaths = [...new Set([config.dbPath, ...(process.env.PROMPTGEN_EVAL_SOURCE_DBS?.split(",").map(item => path.resolve(config.rootDir, item.trim())).filter(Boolean) ?? [])])];
const byId = new Map<string, EvidenceRecord>();
for (const sourcePath of sourcePaths) {
  using db = new EvidenceDatabase(sourcePath);
  for (const record of db.evidenceByIds(ids.filter(id => !byId.has(id)))) byId.set(record.id, record);
}
const records = [...byId.values()].flatMap(record => {
  const safe = transformEvidenceForExternal(record).evidence;
  if (!safe) return [];
  const { productLine: _productLine, segment: _segment, ...rest } = record;
  const frozen: EvidenceRecord = { ...rest, claim: safe.safeSummary, quote: safe.safeSummary, tags: safe.tags };
  return [frozen];
});
if (records.length < ids.length * 0.95) throw new Error(`Could freeze only ${records.length}/${ids.length} evidence records; at least 95% coverage is required`);
const target = path.join(directory, "evidence.json"), temporary = `${target}.tmp`;
await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), records }, null, 2)}\n`, "utf8");
await rename(temporary, target);
process.stdout.write(`${JSON.stringify({ records: records.length, requested: ids.length, coverage: records.length / ids.length, target })}\n`);
