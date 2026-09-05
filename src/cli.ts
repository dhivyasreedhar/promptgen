#!/usr/bin/env node
import { companyById, loadConfig } from "./config.js";
import { evaluateRetrieval } from "./eval.js";
import { evaluateIndependentBenchmark } from "./eval-benchmark.js";
import { evaluateHumanAnnotations, prepareHumanEvaluation } from "./eval-human.js";
import { readOpenAiJudgeReport, rerankFrozenRetrievalCorpus, runOpenAiJudge } from "./eval-llm-judge.js";
import { runCompany } from "./pipeline/run.js";
import { scheduler } from "./scheduler.js";
import { serve } from "./server.js";
import { migratePostgres, postgresHealth } from "./store/postgres-admin.js";

try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}

const [command = "help", target, ...flags] = process.argv.slice(2);
const fixtures = process.argv.includes("--fixtures");
const config = await loadConfig();

switch (command) {
  case "run": {
    if (!target || target.startsWith("--")) throw new Error("Usage: promptgen run <company-id|domain> [--fixtures]");
    const result = await runCompany(config, companyById(config, target), { fixtures });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === "failed" ? 1 : 0;
    break;
  }
  case "run-all": {
    let failed = false;
    for (const company of config.companies) {
      const result = await runCompany(config, company, { fixtures });
      failed ||= result.status === "failed";
    }
    process.exitCode = failed ? 1 : 0;
    break;
  }
  case "scheduler":
    await scheduler(config, fixtures);
    break;
  case "eval":
    process.stdout.write(`${JSON.stringify({ fixtureCoverage: await evaluateRetrieval(config), safetyRegression: await evaluateIndependentBenchmark(config),
      humanEvaluation: await evaluateHumanAnnotations(config.rootDir) }, null, 2)}\n`);
    break;
  case "eval-prepare":
    process.stdout.write(`${JSON.stringify(await prepareHumanEvaluation(config), null, 2)}\n`);
    break;
  case "eval-human":
    process.stdout.write(`${JSON.stringify(await evaluateHumanAnnotations(config.rootDir), null, 2)}\n`);
    break;
  case "eval-gate": {
    const report = await evaluateHumanAnnotations(config.rootDir);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.passed ? 0 : 1;
    break;
  }
  case "eval-judge":
    process.stdout.write(`${JSON.stringify(await runOpenAiJudge(config), null, 2)}\n`);
    break;
  case "eval-judge-report":
    process.stdout.write(`${JSON.stringify(await readOpenAiJudgeReport(config), null, 2)}\n`);
    break;
  case "eval-rerank":
    process.stdout.write(`${JSON.stringify(await rerankFrozenRetrievalCorpus(config), null, 2)}\n`);
    break;
  case "serve":
    await serve(config, fixtures);
    break;
  case "postgres-migrate": {
    if (!config.postgresUrl) throw new Error("DATABASE_URL is not configured");
    process.stdout.write(`${JSON.stringify(await migratePostgres(config.postgresUrl, config.rootDir), null, 2)}\n`);
    break;
  }
  case "postgres-health": {
    if (!config.postgresUrl) throw new Error("DATABASE_URL is not configured");
    process.stdout.write(`${JSON.stringify(await postgresHealth(config.postgresUrl, config.tenantId, config.tenantName), null, 2)}\n`);
    break;
  }
  case "postgres-search": {
    if (!config.postgresUrl) throw new Error("DATABASE_URL is not configured");
    if (!target) throw new Error("Usage: postgres-search <company-id> <query>");
    const [{ PostgresMetadataStore }, { OllamaEmbeddingProvider }] = await Promise.all([
      import("./store/postgres-metadata.js"), import("./retrieval/embeddings.js")]);
    await using store = new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName);
    const provider = config.embeddingProvider === "ollama"
      ? new OllamaEmbeddingProvider(config.embeddingModel, config.embeddingDimensions, config.ollamaUrl)
      : undefined;
    const values = provider ? (await provider.embedQueries([flags.join(" ")]))[0] : undefined;
    const hits = await store.searchEvidence({ companyKey: target, query: flags.join(" "),
      kinds: ["capability", "demand", "constraint", "comparison", "language", "change"], scopes: ["public", "company"], limit: 20,
      ...(provider && values ? { embedding: { provider: provider.provider, model: provider.model, dimensions: provider.dimensions, values } } : {}) });
    process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
    break;
  }
  case "postgres-embed": {
    if (!config.postgresUrl) throw new Error("DATABASE_URL is not configured");
    if (config.embeddingProvider !== "ollama") throw new Error("Set PROMPTGEN_EMBEDDING_PROVIDER=ollama to create local embeddings");
    if (!target) throw new Error("Usage: postgres-embed <company-id> [limit]");
    const limit = Math.min(5_000, Math.max(1, Number(flags[0] ?? 500)));
    const [{ PostgresMetadataStore }, { OllamaEmbeddingProvider, embeddingInputHash }] = await Promise.all([
      import("./store/postgres-metadata.js"), import("./retrieval/embeddings.js")]);
    await using store = new PostgresMetadataStore(config.postgresUrl, config.tenantId, config.tenantName);
    const provider = new OllamaEmbeddingProvider(config.embeddingModel, config.embeddingDimensions, config.ollamaUrl);
    const pending = await store.evidenceMissingEmbeddings(target, provider.provider, provider.model, limit);
    let completed = 0;
    for (let offset = 0; offset < pending.length; offset += 64) {
      const batch = pending.slice(offset, offset + 64); const vectors = await provider.embedDocuments(batch.map(item => item.claim));
      await store.writeEmbeddings(batch.map((item, index) => ({ id: item.id, embedding: vectors[index]!, inputHash: embeddingInputHash(item.claim) })),
        provider.provider, provider.model, provider.dimensions);
      completed += batch.length;
    }
    process.stdout.write(`${JSON.stringify({ companyId: target, provider: provider.provider, model: provider.model,
      dimensions: provider.dimensions, embedded: completed, remainingMayExist: completed === limit })}\n`);
    break;
  }
  default:
    process.stdout.write(["Manicule Promptgen V2", "", "Commands:", "  run <company> [--fixtures]", "  run-all [--fixtures]", "  scheduler [--fixtures]", "  serve [--fixtures]", "  eval (safety regression + human quality report)", "  eval-prepare", "  eval-human", "  eval-gate", "  eval-judge", "  eval-judge-report", "  eval-rerank", "  postgres-migrate", "  postgres-health", "  postgres-search <company-id> <query>", "  postgres-embed <company-id> [limit]", ""].join("\n"));
    if (command !== "help") process.exitCode = 1;
}
