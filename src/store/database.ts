import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CompanyConfig, EvidenceRecord, RunJob, RunResult, SourceArtifact, SourceHealth, TraceEvent } from "../types.js";

export class EvidenceDatabase implements Disposable {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;");
    this.migrate();
  }

  [Symbol.dispose](): void {
    this.db.close();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        version TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        visibility TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        metadata_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        extracted_version TEXT,
        is_current INTEGER NOT NULL DEFAULT 1,
        UNIQUE(company_id, source, external_id, version)
      );
      CREATE INDEX IF NOT EXISTS artifacts_company_source ON artifacts(company_id, source);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        visibility TEXT NOT NULL,
        kind TEXT NOT NULL,
        claim TEXT NOT NULL,
        quote TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        product_line TEXT,
        segment TEXT,
        confidence REAL NOT NULL,
        occurred_at TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        safe_use TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_company_kind ON evidence(company_id, kind);
      CREATE INDEX IF NOT EXISTS evidence_artifact ON evidence(artifact_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
        evidence_id UNINDEXED, company_id UNINDEXED, claim, quote, tags
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_company_started ON runs(company_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS trace_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        company_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_run_sequence ON trace_events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_cache (
        key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_health (
        company_id TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
        collected_artifacts INTEGER NOT NULL, changed_artifacts INTEGER NOT NULL, last_success_at TEXT, error TEXT,
        PRIMARY KEY(company_id, source)
      );
      CREATE TABLE IF NOT EXISTS run_jobs (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, status TEXT NOT NULL, company_json TEXT NOT NULL,
        fixtures INTEGER NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        lease_owner TEXT, lease_expires_at TEXT, result_json TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at TEXT
      );
      CREATE INDEX IF NOT EXISTS run_jobs_status_created ON run_jobs(status, created_at);
    `);
    this.ensureColumn("evidence", "acl_scopes_json", "TEXT NOT NULL DEFAULT '[\"company\"]'");
    this.ensureColumn("evidence", "lifecycle", "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn("evidence", "authority", "REAL NOT NULL DEFAULT 0.5");
    this.ensureColumn("evidence", "valid_from", "TEXT");
    this.ensureColumn("evidence", "valid_to", "TEXT");
    this.ensureColumn("evidence", "buyer_intent", "TEXT NOT NULL DEFAULT 'irrelevant'");
    this.ensureColumn("run_jobs", "cancellation_requested_at", "TEXT");
    this.ensureColumn("run_jobs", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("run_jobs", "max_attempts", "INTEGER NOT NULL DEFAULT 3");
    this.ensureColumn("run_jobs", "available_at", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  upsertArtifact(artifact: SourceArtifact, contentHash: string): boolean {
    const existing = this.db.prepare("SELECT content_hash FROM artifacts WHERE id = ?").get(artifact.id) as { content_hash: string } | undefined;
    this.db.prepare("UPDATE artifacts SET is_current = 0 WHERE company_id = ? AND source = ? AND external_id = ? AND id != ?")
      .run(artifact.companyId, artifact.source, artifact.externalId, artifact.id);
    this.db.prepare(`
      INSERT INTO artifacts(id, company_id, source, external_id, version, occurred_at, collected_at, visibility, title, content, url, metadata_json, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        occurred_at=excluded.occurred_at, collected_at=excluded.collected_at, visibility=excluded.visibility,
        title=excluded.title, content=excluded.content, url=excluded.url, metadata_json=excluded.metadata_json,
        content_hash=excluded.content_hash,
        extracted_version=CASE WHEN artifacts.content_hash=excluded.content_hash THEN artifacts.extracted_version ELSE NULL END,
        is_current=1
    `).run(
      artifact.id, artifact.companyId, artifact.source, artifact.externalId, artifact.version,
      artifact.occurredAt, artifact.collectedAt, artifact.visibility, artifact.title, artifact.content,
      artifact.url ?? null, JSON.stringify(artifact.metadata), contentHash,
    );
    return existing?.content_hash !== contentHash;
  }

  upsertArtifacts(items: Array<{ artifact: SourceArtifact; contentHash: string }>): number {
    let changed = 0;
    // Keep writer leases short enough for concurrent company jobs sharing WAL.
    for (let offset = 0; offset < items.length; offset += 500) {
      const batch = items.slice(offset, offset + 500);
      const writeBatch = this.db.transaction(() => batch.reduce((count, item) => count + Number(this.upsertArtifact(item.artifact, item.contentHash)), 0));
      changed += writeBatch.immediate();
    }
    return changed;
  }

  pendingArtifacts(companyId: string, extractorVersion: string): SourceArtifact[] {
    const rows = this.db.prepare(`
      SELECT * FROM artifacts WHERE company_id = ? AND (extracted_version IS NULL OR extracted_version != ?)
      ORDER BY occurred_at DESC
    `).all(companyId, extractorVersion) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  }

  replaceEvidence(artifactId: string, extractorVersion: string, records: EvidenceRecord[]): void {
    this.replaceEvidenceBatch([{ artifactId, extractorVersion, records }]);
  }

  replaceEvidenceBatch(items: Array<{ artifactId: string; extractorVersion: string; records: EvidenceRecord[] }>): void {
    if (items.length === 0) return;
    const replaceBatch = this.db.transaction(() => {
      const artifactIds = [...new Set(items.map(item => item.artifactId))];
      const placeholders = artifactIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM evidence_fts WHERE evidence_id IN (SELECT id FROM evidence WHERE artifact_id IN (${placeholders}))`).run(...artifactIds);
      this.db.prepare(`DELETE FROM evidence WHERE artifact_id IN (${placeholders})`).run(...artifactIds);
      const insert = this.db.prepare(`
        INSERT INTO evidence(id, company_id, artifact_id, source, visibility, kind, claim, quote, tags_json,
          product_line, segment, confidence, occurred_at, extractor_version, safe_use, acl_scopes_json,
          lifecycle, authority, valid_from, valid_to, buyer_intent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = this.db.prepare("INSERT INTO evidence_fts(evidence_id, company_id, claim, quote, tags) VALUES (?, ?, ?, ?, ?)");
      const markExtracted = this.db.prepare("UPDATE artifacts SET extracted_version = ? WHERE id = ?");
      for (const item of items) {
        for (const record of item.records) {
          insert.run(record.id, record.companyId, record.artifactId, record.source, record.visibility, record.kind,
            record.claim, record.quote, JSON.stringify(record.tags), record.productLine ?? null, record.segment ?? null,
            record.confidence, record.occurredAt, record.extractorVersion, record.safeUse,
            JSON.stringify(record.aclScopes ?? [record.visibility === "public" ? "public" : "company"]),
            record.lifecycle ?? "unknown", record.authority ?? 0.5, record.validFrom ?? null, record.validTo ?? null,
            record.buyerIntent ?? "irrelevant");
          insertFts.run(record.id, record.companyId, record.claim, record.quote, record.tags.join(" "));
        }
        markExtracted.run(item.extractorVersion, item.artifactId);
      }
    });
    replaceBatch.immediate();
  }

  evidenceForCompany(companyId: string, limit?: number): EvidenceRecord[] {
    const sql = `SELECT e.* FROM evidence e JOIN artifacts a ON a.id=e.artifact_id WHERE e.company_id = ? AND a.is_current=1 ORDER BY e.occurred_at DESC${limit === undefined ? "" : " LIMIT ?"}`;
    const rows = (limit === undefined ? this.db.prepare(sql).all(companyId) : this.db.prepare(sql).all(companyId, limit)) as Record<string, unknown>[];
    return rows.map(rowToEvidence);
  }

  artifactsForCompany(companyId: string): SourceArtifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE company_id=? AND is_current=1 ORDER BY occurred_at DESC")
      .all(companyId) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  }

  artifactsByIds(ids: string[]): SourceArtifact[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM artifacts WHERE id IN (${placeholders})`).all(...unique) as Record<string, unknown>[]).map(rowToArtifact);
  }

  evidenceTagsForCompany(companyId: string): string[] {
    const rows = this.db.prepare("SELECT e.tags_json FROM evidence e JOIN artifacts a ON a.id=e.artifact_id WHERE e.company_id=? AND a.is_current=1").all(companyId) as Array<{ tags_json: string }>;
    return [...new Set(rows.flatMap(row => JSON.parse(row.tags_json) as string[]))];
  }

  evidenceByIds(ids: string[]): EvidenceRecord[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM evidence WHERE id IN (${placeholders})`).all(...unique) as Record<string, unknown>[];
    return rows.map(rowToEvidence);
  }

  searchEvidence(companyId: string, terms: string[], limit: number, kind?: EvidenceRecord["kind"]): Array<{ record: EvidenceRecord; lexicalRank: number }> {
    if (terms.length === 0) return this.evidenceForCompany(companyId, limit).map((record, index) => ({ record, lexicalRank: index + 1 }));
    const query = terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const kindClause = kind ? " AND e.kind = ?" : "";
    const statement = this.db.prepare(`
      SELECT e.*, bm25(evidence_fts) AS rank
      FROM evidence_fts JOIN evidence e ON e.id = evidence_fts.evidence_id JOIN artifacts a ON a.id=e.artifact_id
      WHERE evidence_fts MATCH ? AND evidence_fts.company_id = ? AND a.is_current=1${kindClause}
      ORDER BY rank LIMIT ?
    `);
    const rows = (kind ? statement.all(query, companyId, kind, limit) : statement.all(query, companyId, limit)) as Record<string, unknown>[];
    return rows.map((row, index) => ({ record: rowToEvidence(row), lexicalRank: index + 1 }));
  }

  startRun(id: string, companyId: string, startedAt: string): void {
    this.db.prepare("INSERT INTO runs(id, company_id, status, started_at) VALUES (?, ?, 'running', ?)").run(id, companyId, startedAt);
  }

  finishRun(result: RunResult): void {
    this.db.prepare("UPDATE runs SET status = ?, completed_at = ?, result_json = ?, error = ? WHERE id = ?")
      .run(result.status, result.completedAt, JSON.stringify(result), result.error ?? null, result.runId);
  }

  appendTrace(event: TraceEvent): void {
    this.db.prepare(`INSERT INTO trace_events(run_id, at, company_id, stage, action, subject_id, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.runId, event.at, event.companyId, event.stage, event.action, event.subjectId ?? null, JSON.stringify(event.data));
  }

  traceForRun(runId: string): TraceEvent[] {
    const rows = this.db.prepare("SELECT * FROM trace_events WHERE run_id = ? ORDER BY sequence").all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      at: String(row.at), runId: String(row.run_id), companyId: String(row.company_id), stage: String(row.stage),
      action: String(row.action), ...(row.subject_id ? { subjectId: String(row.subject_id) } : {}),
      data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    }));
  }

  lastSuccessfulRunAt(companyId: string): string | undefined {
    const row = this.db.prepare("SELECT completed_at FROM runs WHERE company_id = ? AND status IN ('complete','insufficient_evidence') ORDER BY completed_at DESC LIMIT 1")
      .get(companyId) as { completed_at: string } | undefined;
    return row?.completed_at;
  }

  latestResults(): RunResult[] {
    const rows = this.db.prepare(`
      SELECT r.result_json FROM runs r
      JOIN (SELECT company_id, MAX(started_at) AS started_at FROM runs WHERE result_json IS NOT NULL GROUP BY company_id) latest
        ON latest.company_id=r.company_id AND latest.started_at=r.started_at
      ORDER BY r.company_id
    `).all() as Array<{ result_json: string }>;
    return rows.map(row => JSON.parse(row.result_json) as RunResult);
  }

  acquireLock(name: string, owner: string, now: Date, ttlMs: number): boolean {
    const expires = new Date(now.getTime() + ttlMs).toISOString();
    this.db.prepare("DELETE FROM locks WHERE name = ? AND expires_at < ?").run(name, now.toISOString());
    try {
      this.db.prepare("INSERT INTO locks(name, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)").run(name, owner, now.toISOString(), expires);
      return true;
    } catch {
      return false;
    }
  }

  releaseLock(name: string, owner: string): void {
    this.db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").run(name, owner);
  }

  renewLock(name: string, owner: string, now: Date, ttlMs: number): boolean {
    return this.db.prepare("UPDATE locks SET expires_at=? WHERE name=? AND owner=?")
      .run(new Date(now.getTime() + ttlMs).toISOString(), name, owner).changes === 1;
  }

  getModelCache<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM model_cache WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setModelCache(key: string, provider: string, operation: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO model_cache(key, provider, operation, value_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, provider, operation, JSON.stringify(value), new Date().toISOString());
  }

  recordSourceHealth(health: SourceHealth): void {
    const prior = this.db.prepare("SELECT last_success_at FROM source_health WHERE company_id=? AND source=?")
      .get(health.companyId, health.source) as { last_success_at?: string } | undefined;
    const lastSuccessAt = health.status === "healthy" ? health.checkedAt : health.lastSuccessAt ?? prior?.last_success_at ?? null;
    this.db.prepare(`INSERT INTO source_health(company_id,source,status,checked_at,collected_artifacts,changed_artifacts,last_success_at,error)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(company_id,source) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
      collected_artifacts=excluded.collected_artifacts,changed_artifacts=excluded.changed_artifacts,last_success_at=excluded.last_success_at,error=excluded.error`)
      .run(health.companyId, health.source, health.status, health.checkedAt, health.collectedArtifacts, health.changedArtifacts, lastSuccessAt, health.error ?? null);
  }

  sourceHealth(companyId: string): SourceHealth[] {
    const rows = this.db.prepare("SELECT * FROM source_health WHERE company_id=? ORDER BY source").all(companyId) as Record<string, unknown>[];
    return rows.map(row => ({
      companyId: String(row.company_id), source: String(row.source) as SourceHealth["source"], status: String(row.status) as SourceHealth["status"],
      checkedAt: String(row.checked_at), collectedArtifacts: Number(row.collected_artifacts), changedArtifacts: Number(row.changed_artifacts),
      ...(row.last_success_at ? { lastSuccessAt: String(row.last_success_at) } : {}), ...(row.error ? { error: String(row.error) } : {}),
    }));
  }

  enqueueJob(job: { id: string; company: CompanyConfig; fixtures: boolean; createdAt: string }): RunJob {
    const existing = this.db.prepare("SELECT * FROM run_jobs WHERE company_id=? AND status IN ('queued','running') ORDER BY created_at LIMIT 1")
      .get(job.company.id) as Record<string, unknown> | undefined;
    if (existing) return rowToJob(existing);
    this.db.prepare("INSERT INTO run_jobs(id,company_id,status,company_json,fixtures,created_at) VALUES(?,?,'queued',?,?,?)")
      .run(job.id, job.company.id, JSON.stringify(job.company), Number(job.fixtures), job.createdAt);
    return this.jobById(job.id)!;
  }

  claimJob(owner: string, now: Date, leaseMs: number): RunJob | undefined {
    const claim = this.db.transaction(() => {
      const iso = now.toISOString();
      const row = this.db.prepare("SELECT id FROM run_jobs WHERE (status='queued' AND (available_at IS NULL OR available_at <= ?)) OR (status='running' AND lease_expires_at < ?) ORDER BY created_at LIMIT 1")
        .get(iso, iso) as { id: string } | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE run_jobs SET status='running',started_at=COALESCE(started_at,?),lease_owner=?,lease_expires_at=?,attempts=attempts+1 WHERE id=?")
        .run(iso, owner, new Date(now.getTime() + leaseMs).toISOString(), row.id);
      return this.jobById(row.id);
    });
    return claim.immediate();
  }

  renewJobLease(id: string, owner: string, now: Date, leaseMs: number): boolean {
    return this.db.prepare("UPDATE run_jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=?")
      .run(new Date(now.getTime() + leaseMs).toISOString(), id, owner).changes === 1;
  }

  finishJob(id: string, owner: string, result: RunResult): void {
    const cancelled = this.isCancellationRequested(id);
    const attempt = this.db.prepare("SELECT attempts,max_attempts FROM run_jobs WHERE id=?").get(id) as { attempts: number; max_attempts: number } | undefined;
    if (!cancelled && result.status === "failed" && result.failure?.retryable !== false && attempt && attempt.attempts < attempt.max_attempts) {
      const backoffMs = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempt.attempts - 1));
      this.db.prepare("UPDATE run_jobs SET status='queued',available_at=?,result_json=?,error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?")
        .run(new Date(Date.now() + backoffMs).toISOString(), JSON.stringify(result), result.error ?? null, id, owner);
      return;
    }
    this.db.prepare("UPDATE run_jobs SET status=?,completed_at=?,result_json=?,error=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?")
      .run(cancelled ? "cancelled" : result.status === "failed" ? "failed" : "complete", result.completedAt, JSON.stringify(result), result.error ?? null, id, owner);
  }

  requestJobCancellation(id: string, at = new Date()): boolean {
    const queued = this.db.prepare("UPDATE run_jobs SET status='cancelled',completed_at=?,cancellation_requested_at=? WHERE id=? AND status='queued'")
      .run(at.toISOString(), at.toISOString(), id).changes;
    const running = this.db.prepare("UPDATE run_jobs SET cancellation_requested_at=? WHERE id=? AND status='running'")
      .run(at.toISOString(), id).changes;
    return queued + running > 0;
  }

  isCancellationRequested(id: string): boolean {
    const row = this.db.prepare("SELECT cancellation_requested_at FROM run_jobs WHERE id=?").get(id) as { cancellation_requested_at?: string } | undefined;
    return Boolean(row?.cancellation_requested_at);
  }

  jobById(id: string): RunJob | undefined {
    const row = this.db.prepare("SELECT * FROM run_jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : undefined;
  }

  activeJobCompanyIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT company_id FROM run_jobs WHERE status IN ('queued','running') ORDER BY company_id").all() as Array<{ company_id: string }>)
      .map(row => row.company_id);
  }
}

function rowToArtifact(row: Record<string, unknown>): SourceArtifact {
  return {
    id: String(row.id), companyId: String(row.company_id), source: String(row.source) as SourceArtifact["source"],
    externalId: String(row.external_id), version: String(row.version), occurredAt: String(row.occurred_at),
    collectedAt: String(row.collected_at), visibility: String(row.visibility) as SourceArtifact["visibility"],
    title: String(row.title), content: String(row.content), metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    ...(row.url ? { url: String(row.url) } : {}),
  };
}

function rowToEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id), companyId: String(row.company_id), artifactId: String(row.artifact_id),
    source: String(row.source) as EvidenceRecord["source"], visibility: String(row.visibility) as EvidenceRecord["visibility"],
    kind: String(row.kind) as EvidenceRecord["kind"], claim: String(row.claim), quote: String(row.quote),
    tags: JSON.parse(String(row.tags_json)) as string[], confidence: Number(row.confidence), occurredAt: String(row.occurred_at),
    extractorVersion: String(row.extractor_version), safeUse: String(row.safe_use) as EvidenceRecord["safeUse"],
    ...(row.acl_scopes_json ? { aclScopes: JSON.parse(String(row.acl_scopes_json)) as string[] } : {}),
    ...(row.lifecycle ? { lifecycle: String(row.lifecycle) as NonNullable<EvidenceRecord["lifecycle"]> } : {}),
    ...(row.authority === null || row.authority === undefined ? {} : { authority: Number(row.authority) }),
    ...(row.valid_from ? { validFrom: String(row.valid_from) } : {}), ...(row.valid_to ? { validTo: String(row.valid_to) } : {}),
    ...(row.buyer_intent ? { buyerIntent: String(row.buyer_intent) as NonNullable<EvidenceRecord["buyerIntent"]> } : {}),
    ...(row.product_line ? { productLine: String(row.product_line) } : {}),
    ...(row.segment ? { segment: String(row.segment) } : {}),
  };
}

function rowToJob(row: Record<string, unknown>): RunJob {
  return {
    id: String(row.id), companyId: String(row.company_id), status: String(row.status) as RunJob["status"],
    company: JSON.parse(String(row.company_json)) as CompanyConfig, fixtures: Boolean(row.fixtures), createdAt: String(row.created_at),
    ...(typeof row.attempts === "number" ? { attempts: row.attempts } : {}),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.result_json ? { result: JSON.parse(String(row.result_json)) as RunResult } : {}), ...(row.error ? { error: String(row.error) } : {}),
  };
}
