import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { PostgresMetadataStore } from "./postgres-metadata.js";

export async function migratePostgres(connectionString: string, rootDir: string): Promise<Array<{ migration: string; status: "applied" | "current" | "baselined" }>> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS promptgen_schema_migrations(
      migration text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const directory = path.join(rootDir, "infra/postgres");
    const files = (await readdir(directory)).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
    const statuses: Array<{ migration: string; status: "applied" | "current" | "baselined" }> = [];
    for (const migration of files) {
      const sql = await readFile(path.join(directory, migration), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await pool.query<{ checksum: string }>("SELECT checksum FROM promptgen_schema_migrations WHERE migration=$1", [migration]);
      if (prior.rows[0]) {
        if (prior.rows[0].checksum !== checksum) throw new Error(`Applied migration ${migration} has been modified`);
        statuses.push({ migration, status: "current" });
        continue;
      }
      const schemaExists = migration.startsWith("001_") && Boolean((await pool.query<{ present: string | null }>("SELECT to_regclass('public.tenants')::text AS present")).rows[0]?.present);
      if (schemaExists) {
        await pool.query("INSERT INTO promptgen_schema_migrations(migration,checksum) VALUES($1,$2)", [migration, checksum]);
        statuses.push({ migration, status: "baselined" });
        continue;
      }
      const body = sql.replace(/^\s*BEGIN\s*;/i, "").replace(/COMMIT\s*;\s*$/i, "");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(body);
        await client.query("INSERT INTO promptgen_schema_migrations(migration,checksum) VALUES($1,$2)", [migration, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
      statuses.push({ migration, status: "applied" });
    }
    return statuses;
  } finally { await pool.end(); }
}

export async function postgresHealth(connectionString: string, tenantId: string, tenantName: string): Promise<Awaited<ReturnType<PostgresMetadataStore["health"]>>> {
  await using store = new PostgresMetadataStore(connectionString, tenantId, tenantName);
  return store.health();
}
