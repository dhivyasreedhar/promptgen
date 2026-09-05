import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SOURCE_TYPES, type CompanyConfig } from "./types.js";

const companySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
  category: z.string().min(3),
  githubOrganizations: z.array(z.string()),
  enabledSources: z.array(z.enum(SOURCE_TYPES)),
});

const envSchema = z.object({
  PROMPTGEN_DB_PATH: z.string().default("./data/promptgen.db"),
  PROMPTGEN_RUNS_DIR: z.string().default("./runs"),
  PROMPTGEN_FIXTURES_DIR: z.string().default("./fixtures/private"),
  PROMPTGEN_PUBLIC_WEB: z.enum(["true", "false"]).default("true"),
  PROMPTGEN_MAX_PUBLIC_PAGES: z.coerce.number().int().min(1).max(100).default(20),
  PROMPTGEN_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  PROMPTGEN_MODEL_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(900_000).default(300_000),
  PROMPTGEN_DAILY_AT: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("02:00"),
  PROMPTGEN_TIMEZONE: z.string().default("UTC"),
  PROMPTGEN_HOST: z.string().min(1).default("127.0.0.1"),
  PROMPTGEN_PORT: z.coerce.number().int().min(1024).max(65_535).optional(),
  PORT: z.coerce.number().int().min(1024).max(65_535).optional(),
  PROMPTGEN_ALLOW_PUBLIC_ACCESS: z.enum(["true", "false"]).default("false"),
  PROMPTGEN_ACCESS_PASSWORD: z.string().min(12).optional(),
  PROMPTGEN_SCHEDULER_ENABLED: z.enum(["true", "false"]).default("false"),
  PROMPTGEN_MODEL_PROVIDER: z.enum(["auto", "anthropic", "openai", "local"]).default("auto"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_JUDGE_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  PROMPTGEN_EMBEDDING_PROVIDER: z.enum(["ollama", "disabled"]).default("ollama"),
  PROMPTGEN_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
  PROMPTGEN_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(16_000).default(768),
  PROMPTGEN_EMBEDDING_RUN_LIMIT: z.coerce.number().int().min(0).max(5_000).default(500),
  PROMPTGEN_OLLAMA_URL: z.string().url().default("http://127.0.0.1:11434"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-6"),
  GITHUB_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  PGPORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  PGDATABASE: z.string().default("postgres"),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),
  PROMPTGEN_TENANT_ID: z.string().uuid().default("00000000-0000-4000-8000-000000000001"),
  PROMPTGEN_TENANT_NAME: z.string().min(1).default("Manicule development"),
  PROMPTGEN_OBJECTS_DIR: z.string().default("./data/objects"),
  PROMPTGEN_OBJECT_ENCRYPTION_KEY: z.string().optional(),
});

export interface AppConfig {
  rootDir: string;
  dbPath: string;
  runsDir: string;
  fixturesDir: string;
  publicWeb: boolean;
  maxPublicPages: number;
  requestTimeoutMs: number;
  modelTimeoutMs: number;
  dailyAt: string;
  timezone: string;
  host: string;
  port: number;
  allowPublicAccess: boolean;
  accessPassword?: string;
  schedulerEnabled: boolean;
  modelProvider: "auto" | "anthropic" | "openai" | "local";
  openaiApiKey?: string;
  openaiModel: string;
  openaiJudgeModel: string;
  openaiEmbeddingModel: string;
  embeddingProvider: "ollama" | "disabled";
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingRunLimit: number;
  ollamaUrl: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  githubToken?: string;
  postgresUrl?: string;
  tenantId: string;
  tenantName: string;
  objectsDir: string;
  objectEncryptionKey?: string;
  companies: CompanyConfig[];
}

export async function loadConfig(rootDir = process.cwd()): Promise<AppConfig> {
  const parsed = envSchema.parse(process.env);
  const postgresUrl = resolvePostgresUrl(parsed);
  const raw = JSON.parse(await readFile(path.join(rootDir, "config/companies.json"), "utf8")) as unknown;
  const companies = z.array(companySchema).parse(raw);
  return {
    rootDir,
    dbPath: path.resolve(rootDir, parsed.PROMPTGEN_DB_PATH),
    runsDir: path.resolve(rootDir, parsed.PROMPTGEN_RUNS_DIR),
    fixturesDir: path.resolve(rootDir, parsed.PROMPTGEN_FIXTURES_DIR),
    publicWeb: parsed.PROMPTGEN_PUBLIC_WEB === "true",
    maxPublicPages: parsed.PROMPTGEN_MAX_PUBLIC_PAGES,
    requestTimeoutMs: parsed.PROMPTGEN_REQUEST_TIMEOUT_MS,
    modelTimeoutMs: parsed.PROMPTGEN_MODEL_TIMEOUT_MS,
    dailyAt: parsed.PROMPTGEN_DAILY_AT,
    timezone: parsed.PROMPTGEN_TIMEZONE,
    host: parsed.PROMPTGEN_HOST,
    port: parsed.PROMPTGEN_PORT ?? parsed.PORT ?? 4317,
    allowPublicAccess: parsed.PROMPTGEN_ALLOW_PUBLIC_ACCESS === "true",
    ...(parsed.PROMPTGEN_ACCESS_PASSWORD ? { accessPassword: parsed.PROMPTGEN_ACCESS_PASSWORD } : {}),
    schedulerEnabled: parsed.PROMPTGEN_SCHEDULER_ENABLED === "true",
    modelProvider: parsed.PROMPTGEN_MODEL_PROVIDER,
    ...(parsed.OPENAI_API_KEY ? { openaiApiKey: parsed.OPENAI_API_KEY } : {}),
    openaiModel: parsed.OPENAI_MODEL,
    openaiJudgeModel: parsed.OPENAI_JUDGE_MODEL,
    openaiEmbeddingModel: parsed.OPENAI_EMBEDDING_MODEL,
    embeddingProvider: parsed.PROMPTGEN_EMBEDDING_PROVIDER,
    embeddingModel: parsed.PROMPTGEN_EMBEDDING_MODEL,
    embeddingDimensions: parsed.PROMPTGEN_EMBEDDING_DIMENSIONS,
    embeddingRunLimit: parsed.PROMPTGEN_EMBEDDING_RUN_LIMIT,
    ollamaUrl: parsed.PROMPTGEN_OLLAMA_URL,
    ...(parsed.ANTHROPIC_API_KEY ? { anthropicApiKey: parsed.ANTHROPIC_API_KEY } : {}),
    anthropicModel: parsed.ANTHROPIC_MODEL,
    ...(parsed.GITHUB_TOKEN ? { githubToken: parsed.GITHUB_TOKEN } : {}),
    ...(postgresUrl ? { postgresUrl } : {}),
    tenantId: parsed.PROMPTGEN_TENANT_ID,
    tenantName: parsed.PROMPTGEN_TENANT_NAME,
    objectsDir: path.resolve(rootDir, parsed.PROMPTGEN_OBJECTS_DIR),
    ...(parsed.PROMPTGEN_OBJECT_ENCRYPTION_KEY ? { objectEncryptionKey: parsed.PROMPTGEN_OBJECT_ENCRYPTION_KEY } : {}),
    companies,
  };
}

function resolvePostgresUrl(env: z.infer<typeof envSchema>): string | undefined {
  if (!env.DATABASE_URL) return undefined;
  const url = new URL(env.DATABASE_URL);
  if (env.PGHOST) url.hostname = env.PGHOST;
  url.port = String(env.PGPORT);
  url.pathname = `/${env.PGDATABASE}`;
  if (env.PGUSER) url.username = env.PGUSER;
  if (env.PGPASSWORD) url.password = env.PGPASSWORD;
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "require");
  if (!url.searchParams.has("uselibpqcompat")) url.searchParams.set("uselibpqcompat", "true");
  return url.toString();
}

export function companyById(config: AppConfig, idOrDomain: string): CompanyConfig {
  const company = config.companies.find((item) => item.id === idOrDomain || item.domain === idOrDomain);
  if (!company) throw new Error(`Unknown company: ${idOrDomain}`);
  return company;
}
