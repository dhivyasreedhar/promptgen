#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "../src/config.js";
import { EvidenceDatabase } from "../src/store/database.js";

try { process.loadEnvFile(); } catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}

const [kind, reviewerId, ...flags] = process.argv.slice(2);
if ((kind !== "retrieval" && kind !== "prompts") || !reviewerId) {
  throw new Error("Usage: npm run eval:annotate -- <retrieval|prompts> <reviewer-id> [--limit=N]");
}
const limit = Math.max(1, Math.min(350, Number(flags.find(flag => flag.startsWith("--limit="))?.split("=")[1] ?? 350)));
const config = await loadConfig();
const file = path.join(config.rootDir, "eval", "annotations", `${kind}.json`);
const corpus = JSON.parse(await readFile(file, "utf8")) as { cases: Array<Record<string, unknown>> };
using db = new EvidenceDatabase(config.dbPath);
const terminal = createInterface({ input, output });
let completed = 0;

try {
  for (const item of corpus.cases) {
    const reviews = (kind === "retrieval" ? item.judgments : item.grades) as Array<Record<string, unknown>>;
    if (reviews.some(review => review.reviewerId === reviewerId)) continue;
    if (completed >= limit) break;
    output.write(`\n${"=".repeat(80)}\n${String(item.id)}\n`);
    const saved = kind === "retrieval" ? await annotateRetrieval(item) : await annotatePrompt(item);
    if (saved === "quit") break;
    if (saved === "skip") continue;
    completed += 1;
    await atomicJson(file, corpus);
  }
} finally {
  terminal.close();
}
output.write(`\nSaved ${completed} ${kind} annotation${completed === 1 ? "" : "s"} for ${reviewerId}.\n`);

async function annotateRetrieval(item: Record<string, unknown>): Promise<"saved" | "skip" | "quit"> {
  output.write(`Query: ${String(item.query)}\nTopic: ${String(item.topic)} · ${String(item.variant)}\n`);
  const ids = item.candidateEvidenceIds as string[];
  const byId = new Map(db.evidenceByIds(ids).map(record => [record.id, record]));
  ids.forEach((id, index) => {
    const record = byId.get(id);
    output.write(`${String(index + 1).padStart(2)}. ${record?.source ?? "missing"}/${record?.kind ?? "missing"}${index < 12 ? " [top12]" : ""} — ${record?.claim ?? id}\n`);
  });
  const relevantInput = (await terminal.question("Relevant evidence numbers (comma-separated), s=skip, q=quit: ")).trim();
  if (relevantInput === "q") return "quit";
  if (relevantInput === "s") return "skip";
  const missedInput = (await terminal.question("Known relevant evidence IDs missing from the pool (comma-separated, blank=none): ")).trim();
  const forbiddenInput = (await terminal.question("Forbidden/unsafe evidence numbers (comma-separated, blank=none): ")).trim();
  const notes = (await terminal.question("Notes (optional): ")).trim();
  const judgment = { reviewerId, reviewedAt: new Date().toISOString(), relevantEvidenceIds: indexes(relevantInput, ids),
    missedRelevantEvidenceIds: missedInput ? missedInput.split(",").map(value => value.trim()).filter(Boolean) : [],
    forbiddenEvidenceIds: indexes(forbiddenInput, ids), ...(notes ? { notes } : {}) };
  (item.judgments as unknown[]).push(judgment); item.status = "reviewed";
  return "saved";
}

async function annotatePrompt(item: Record<string, unknown>): Promise<"saved" | "skip" | "quit"> {
  output.write(`Prompt: ${String(item.text)}\nAutomated decision: ${String(item.automatedDecision)} · ${(item.automatedFindings as string[]).join(", ") || "no findings"}\n`);
  const evidenceIds = item.evidenceIds as string[];
  db.evidenceByIds(evidenceIds).forEach((record, index) => output.write(`${index + 1}. ${record.source}/${record.kind} — ${record.claim}\n`));
  const scoreInput = (await terminal.question("Scores 1–5: buyer-intent,recommendation,evidence,distinctness,naturalness (s=skip, q=quit): ")).trim();
  if (scoreInput === "q") return "quit";
  if (scoreInput === "s") return "skip";
  const scores = scoreInput.split(",").map(value => Number(value.trim()));
  if (scores.length !== 5 || scores.some(value => !Number.isInteger(value) || value < 1 || value > 5)) {
    output.write("Invalid scores; case skipped.\n"); return "skip";
  }
  const acceptInput = (await terminal.question("Accept this tracking prompt? (y/n): ")).trim().toLowerCase();
  if (acceptInput !== "y" && acceptInput !== "n") { output.write("Invalid acceptance; case skipped.\n"); return "skip"; }
  const notes = (await terminal.question("Notes (optional): ")).trim();
  const [buyerIntent, recommendationLikelihood, evidenceEntailment, distinctness, naturalness] = scores as [number, number, number, number, number];
  const grade = { reviewerId, reviewedAt: new Date().toISOString(), buyerIntent, recommendationLikelihood, evidenceEntailment,
    distinctness, naturalness, accept: acceptInput === "y", ...(notes ? { notes } : {}) };
  (item.grades as unknown[]).push(grade); item.status = "reviewed";
  return "saved";
}

function indexes(value: string, ids: string[]): string[] {
  if (!value) return [];
  const selected = value.split(",").map(item => Number(item.trim()));
  if (selected.some(index => !Number.isInteger(index) || index < 1 || index > ids.length)) throw new Error("Evidence number out of range");
  return [...new Set(selected.map(index => ids[index - 1]!))];
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}
