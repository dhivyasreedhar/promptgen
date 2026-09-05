import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { EvidenceDatabase } from "./store/database.js";

export interface EvalResult { companyId: string; expectedTopics: number; retrievedTopics: number; topicRecall: number }

export async function evaluateRetrieval(config: AppConfig): Promise<EvalResult[]> {
  using db = new EvidenceDatabase(config.dbPath);
  const output: EvalResult[] = [];
  for (const company of config.companies) {
    const expected = JSON.parse(await readFile(path.join(config.rootDir, "fixtures/gold", `${company.id}.json`), "utf8")) as Array<{ topic: string }>;
    const tags = new Set(db.evidenceForCompany(company.id).flatMap(record => record.tags));
    const hits = expected.filter(item => tags.has(item.topic)).length;
    output.push({ companyId: company.id, expectedTopics: expected.length, retrievedTopics: hits, topicRecall: hits / expected.length });
  }
  return output;
}
