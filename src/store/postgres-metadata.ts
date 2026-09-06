import { Pool, type PoolClient } from "pg";
import type { CompanyConfig, EvidenceRecord, FeedbackReason, RunJob, RunResult, SourceArtifact, SourceHealth, TraceEvent, TrackingPrompt } from "../types.js";
import type { StoredEmbedding } from "../retrieval/embeddings.js";
import { stableId, stableUuid } from "../util.js";

export class PostgresMetadataStore implements AsyncDisposable {
  private readonly pool: Pool;

  constructor(
    connectionString: string,
    private readonly tenantId: string,
    private readonly tenantName: string,
  ) {
    this.pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", () => undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
  async close(): Promise<void> { await this.pool.end(); }

  async health(): Promise<{ database: string; serverVersion: string; vectorVersion: string; rlsTables: number }> {
    return this.transaction(async client => {
      const result = await client.query<{ database: string; server_version: string; vector_version: string; rls_tables: string }>(`
        SELECT current_database() AS database, current_setting('server_version') AS server_version,
          (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector_version,
          (SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity) AS rls_tables
      `);
      const row = result.rows[0]!;
      return { database: row.database, serverVersion: row.server_version, vectorVersion: row.vector_version, rlsTables: Number(row.rls_tables) };
    });
  }

  async startRun(company: CompanyConfig, runId: string, startedAt: string, provider: string): Promise<void> {
    await this.transaction(async client => {
      const companyId = await this.ensureCompany(client, company);
      await client.query(`INSERT INTO runs(id,tenant_id,company_id,status,provider,started_at)
        VALUES($1,$2,$3,'running',$4,$5)
        ON CONFLICT(id) DO UPDATE SET status='running',provider=excluded.provider,started_at=excluded.started_at`,
      [stableUuid("run", runId), this.tenantId, companyId, provider, startedAt]);
    });
  }

  async finishRun(company: CompanyConfig, result: RunResult, health: SourceHealth[], events: TraceEvent[], publishPrompts = true): Promise<void> {
    await this.transaction(async client => {
      const companyId = await this.ensureCompany(client, company);
      const runUuid = stableUuid("run", result.runId);
      await client.query(`INSERT INTO runs(id,tenant_id,company_id,status,provider,started_at,completed_at,result,error,published)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,provider=excluded.provider,completed_at=excluded.completed_at,
          result=excluded.result,error=excluded.error,published=runs.published OR excluded.published`,
      [runUuid, this.tenantId, companyId, result.status, result.provider, result.startedAt, result.completedAt, JSON.stringify(result), result.error ?? null, publishPrompts]);
      for (const item of health) {
        await client.query(`INSERT INTO source_connections(tenant_id,company_id,source,status,cursor,last_attempt_at,last_success_at,last_error)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
          ON CONFLICT(tenant_id,company_id,source) DO UPDATE SET status=excluded.status,cursor=excluded.cursor,
            last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,last_error=excluded.last_error`,
        [this.tenantId, companyId, item.source, item.status, JSON.stringify({ collectedArtifacts: item.collectedArtifacts, changedArtifacts: item.changedArtifacts }),
          item.checkedAt, item.lastSuccessAt ?? null, item.error ?? null]);
      }
      await client.query("DELETE FROM trace_events WHERE tenant_id=$1 AND run_id=$2", [this.tenantId, runUuid]);
      for (const event of events) {
        await client.query(`INSERT INTO trace_events(tenant_id,company_id,run_id,at,stage,action,subject_id,data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [this.tenantId, companyId, runUuid, event.at, event.stage, event.action, event.subjectId ?? null, JSON.stringify(event.data)]);
      }
      if (publishPrompts && result.status !== "failed") {
        const prior = await client.query<{ semantic_key: string; stable_key: string }>(
          "SELECT semantic_key,stable_key FROM tracking_prompts WHERE tenant_id=$1 AND company_id=$2 AND active", [this.tenantId, companyId]);
        const priorBySemantic = new Map(prior.rows.map(row => [row.semantic_key, row.stable_key]));
        const keys = result.discoveryPrompts.map(prompt => prompt.id);
        await client.query("UPDATE tracking_prompts SET active=false WHERE tenant_id=$1 AND company_id=$2 AND NOT pinned AND NOT(stable_key=ANY($3::text[]))", [this.tenantId, companyId, keys]);
        for (const prompt of result.discoveryPrompts) await client.query(`INSERT INTO tracking_prompts(
          id,tenant_id,company_id,stable_key,semantic_key,text,archetype,evidence_keys,score,active,first_seen_at,last_seen_at,latest_run_id,coverage,origin,set_type)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$10,$11,$12::jsonb,$13,$14)
          ON CONFLICT(tenant_id,company_id,stable_key) DO UPDATE SET
            text=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.text ELSE excluded.text END,
            archetype=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.archetype ELSE excluded.archetype END,
            semantic_key=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.semantic_key ELSE excluded.semantic_key END,
            evidence_keys=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.evidence_keys ELSE excluded.evidence_keys END,
            score=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.score ELSE excluded.score END,active=true,
            last_seen_at=excluded.last_seen_at,latest_run_id=excluded.latest_run_id,
            coverage=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.coverage ELSE excluded.coverage END,
            origin=CASE WHEN tracking_prompts.pinned THEN tracking_prompts.origin ELSE excluded.origin END,
            set_type=CASE WHEN tracking_prompts.pinned THEN 'benchmark' ELSE excluded.set_type END`,
        [stableUuid("prompt", this.tenantId, company.id, prompt.id), this.tenantId, companyId, prompt.id,
          prompt.semanticKey ?? prompt.id, prompt.text, prompt.archetype, prompt.evidenceIds, prompt.score, result.completedAt, runUuid,
          JSON.stringify(prompt.coverage), prompt.origin, prompt.set]);
        const currentBySemantic = new Map(result.discoveryPrompts.map(prompt => [prompt.semanticKey ?? prompt.id, prompt.id]));
        const semanticKeys = new Set([...priorBySemantic.keys(), ...currentBySemantic.keys()]);
        for (const semanticKey of semanticKeys) {
          const action = priorBySemantic.has(semanticKey) ? currentBySemantic.has(semanticKey) ? "retained" : "removed" : "added";
          await client.query(`INSERT INTO prompt_lifecycle_events(tenant_id,company_id,run_id,semantic_key,stable_key,action,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [this.tenantId, companyId, runUuid, semanticKey,
            currentBySemantic.get(semanticKey) ?? priorBySemantic.get(semanticKey) ?? null, action, result.completedAt]);
        }
      }
    });
  }

  async recordPromptFeedback(companyKey: string, promptKey: string, verdict: "approved" | "rejected" | "edited", editedText?: string, notes?: string,
    reason?: FeedbackReason, ruleScope: "prompt" | "set" = "prompt"): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query<{ id: string }>(`SELECT p.id FROM tracking_prompts p JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND c.external_key=$2 AND p.stable_key=$3`, [this.tenantId, companyKey, promptKey]);
      const promptId = result.rows[0]?.id;
      if (!promptId) throw new Error("Prompt not found");
      await client.query("INSERT INTO prompt_feedback(tenant_id,prompt_id,verdict,edited_text,notes,reason,rule_scope) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [this.tenantId, promptId, verdict, editedText ?? null, notes ?? null, reason ?? null, ruleScope]);
      if (verdict === "approved") await client.query("UPDATE tracking_prompts SET pinned=true,set_type='benchmark',active=true WHERE tenant_id=$1 AND id=$2", [this.tenantId, promptId]);
      if (verdict === "edited" && editedText) await client.query("UPDATE tracking_prompts SET text=$3,last_seen_at=now(),origin='customer-authored',evidence_keys='{}',pinned=true,set_type='benchmark',active=true WHERE tenant_id=$1 AND id=$2", [this.tenantId, promptId, editedText]);
      if (verdict === "rejected") await client.query("UPDATE tracking_prompts SET active=false,pinned=false,set_type='discovery' WHERE tenant_id=$1 AND id=$2", [this.tenantId, promptId]);
      if (verdict === "rejected" && reason && ruleScope === "set") {
        const prompt = await client.query<{ company_id: string; semantic_key: string; coverage: Record<string,string> }>(
          "SELECT company_id,semantic_key,coverage FROM tracking_prompts WHERE tenant_id=$1 AND id=$2", [this.tenantId, promptId]);
        const row = prompt.rows[0];
        if (row) {
          const dimension = reason === "wrong-audience" ? "audience" : reason === "too-niche" ? "useCase" : "semanticKey";
          const value = dimension === "semanticKey" ? row.semantic_key : String(row.coverage?.[dimension] ?? row.semantic_key);
          await client.query(`INSERT INTO prompt_feedback_rules(tenant_id,company_id,reason,dimension,value) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(tenant_id,company_id,reason,dimension,value) WHERE active DO NOTHING`, [this.tenantId, row.company_id, reason, dimension, value]);
        }
      }
    });
  }

  async addManualPrompt(companyKey: string, text: string): Promise<string> {
    return this.transaction(async client => {
      const company = await client.query<{ id: string }>("SELECT id FROM companies WHERE tenant_id=$1 AND external_key=$2", [this.tenantId, companyKey]);
      const companyId = company.rows[0]?.id;
      if (!companyId) throw new Error("Company not found");
      const duplicate = await client.query("SELECT 1 FROM tracking_prompts WHERE tenant_id=$1 AND company_id=$2 AND lower(text)=lower($3) AND active", [this.tenantId, companyId, text]);
      if (duplicate.rowCount) throw new Error("This prompt is already in the set");
      const stableKey = `manual-${stableId(companyKey, text.toLowerCase())}`;
      const promptId = stableUuid("prompt", this.tenantId, companyKey, stableKey);
      const coverage = { audience: "customer-defined", useCase: "customer-defined", constraint: "none stated", decisionStage: "evaluation" };
      await client.query(`INSERT INTO tracking_prompts(id,tenant_id,company_id,stable_key,semantic_key,text,archetype,evidence_keys,score,active,first_seen_at,last_seen_at,coverage,origin,set_type,pinned)
        VALUES($1,$2,$3,$4,$4,$5,'category','{}',1,true,now(),now(),$6::jsonb,'customer-authored','benchmark',true)
        ON CONFLICT(tenant_id,company_id,stable_key) DO UPDATE SET text=excluded.text,active=true,pinned=true,set_type='benchmark',last_seen_at=now()`,
      [promptId, this.tenantId, companyId, stableKey, text, JSON.stringify(coverage)]);
      await client.query("INSERT INTO prompt_feedback(tenant_id,prompt_id,verdict,notes,rule_scope) VALUES($1,$2,'approved','Added by customer','prompt')", [this.tenantId, promptId]);
      return stableKey;
    });
  }

  async promptStates(companyKey: string): Promise<Array<{ stableKey: string; text: string; active: boolean }>> {
    return this.transaction(async client => (await client.query<{ stable_key: string; text: string; active: boolean }>(`SELECT p.stable_key,p.text,p.active FROM tracking_prompts p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND c.external_key=$2`, [this.tenantId, companyKey])).rows.map(row => ({
        stableKey: row.stable_key, text: row.text, active: row.active,
      })));
  }

  async recordAgentObservation(input: { companyKey: string; promptKey: string; agent: string; evaluatedAt: string; companyMentioned: boolean; citedUrls: string[]; competitors: string[]; answerHash?: string }): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query<{ id: string }>(`SELECT p.id FROM tracking_prompts p JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND c.external_key=$2 AND p.stable_key=$3`, [this.tenantId, input.companyKey, input.promptKey]);
      const promptId = result.rows[0]?.id;
      if (!promptId) throw new Error("Prompt not found");
      await client.query(`INSERT INTO agent_eval_observations(tenant_id,prompt_id,agent,evaluated_at,company_mentioned,cited_urls,competitors,answer_hash)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(tenant_id,prompt_id,agent,evaluated_at) DO UPDATE SET
        company_mentioned=excluded.company_mentioned,cited_urls=excluded.cited_urls,competitors=excluded.competitors,answer_hash=excluded.answer_hash`,
      [this.tenantId, promptId, input.agent, input.evaluatedAt, input.companyMentioned, JSON.stringify(input.citedUrls), input.competitors, input.answerHash ?? null]);
    });
  }

  async promptGuidance(companyKey: string): Promise<{ rejected: string[]; preferred: string[]; benchmark: string[]; rules: Array<{ reason: string; dimension: string; value: string }> }> {
    return this.transaction(async client => {
      const result = await client.query<{ stable_key: string; semantic_key: string; verdict: string | null; mention_rate: number | null }>(`SELECT p.stable_key,p.semantic_key,
        (SELECT f.verdict FROM prompt_feedback f WHERE f.tenant_id=p.tenant_id AND f.prompt_id=p.id ORDER BY f.created_at DESC LIMIT 1) verdict,
        (SELECT avg(CASE WHEN o.company_mentioned THEN 1.0 ELSE 0.0 END)::real FROM agent_eval_observations o
          WHERE o.tenant_id=p.tenant_id AND o.prompt_id=p.id) mention_rate
        FROM tracking_prompts p JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND c.external_key=$2`, [this.tenantId, companyKey]);
      const rules = await client.query<{ reason: string; dimension: string; value: string }>(`SELECT r.reason,r.dimension,r.value FROM prompt_feedback_rules r
        JOIN companies c ON c.id=r.company_id AND c.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND c.external_key=$2 AND r.active`, [this.tenantId, companyKey]);
      return {
        rejected: result.rows.filter(row => row.verdict === "rejected").flatMap(row => [row.stable_key, row.semantic_key]),
        preferred: result.rows.filter(row => row.verdict === "approved" || (row.mention_rate !== null && row.mention_rate < 0.5)).flatMap(row => [row.stable_key, row.semantic_key]),
        benchmark: result.rows.filter(row => row.verdict === "approved").flatMap(row => [row.stable_key, row.semantic_key]),
        rules: rules.rows,
      };
    });
  }

  async activePromptKeys(companyKey: string): Promise<string[]> {
    return this.transaction(async client => (await client.query<{ semantic_key: string }>(`SELECT p.semantic_key FROM tracking_prompts p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND c.external_key=$2 AND p.active AND NOT p.pinned
      ORDER BY p.semantic_key`, [this.tenantId, companyKey])).rows.map(row => row.semantic_key));
  }

  async benchmarkPrompts(companyKey: string): Promise<TrackingPrompt[]> {
    return this.transaction(async client => (await client.query<Record<string, unknown>>(`SELECT p.stable_key,p.semantic_key,p.text,p.archetype,
      p.evidence_keys,p.score,p.coverage,p.origin FROM tracking_prompts p JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND c.external_key=$2 AND p.pinned AND p.active ORDER BY p.first_seen_at`, [this.tenantId, companyKey])).rows.map(row => ({
        id: String(row.stable_key), semanticKey: String(row.semantic_key), opportunityId: String(row.semantic_key), text: String(row.text),
        archetype: String(row.archetype) as TrackingPrompt["archetype"], evidenceIds: row.evidence_keys as string[], score: Number(row.score),
        origin: String(row.origin) as TrackingPrompt["origin"], coverage: row.coverage as TrackingPrompt["coverage"], set: "benchmark" as const,
      })));
  }

  async syncArtifacts(company: CompanyConfig, artifacts: SourceArtifact[], hashes: Map<string, string>, objectKeys = new Map<string, string>()): Promise<void> {
    if (artifacts.length === 0) return;
    for (let offset = 0; offset < artifacts.length; offset += 500) {
      const batch = [...new Map(artifacts.slice(offset, offset + 500)
        .map(item => [`${item.source}\u0000${item.externalId}\u0000${item.version}`, item])).values()];
      await this.transaction(async client => {
        const companyId = await this.ensureCompany(client, company);
        const rows = batch.map(item => ({ id: stableUuid("artifact", this.tenantId, company.id, item.id), local_key: item.id,
          source: item.source, external_id: item.externalId, version: item.version, occurred_at: item.occurredAt,
          collected_at: item.collectedAt, visibility: item.visibility, title: item.title,
          object_key: objectKeys.get(item.id) ?? `sqlite://${company.id}/${item.id}`, content_hash: hashes.get(item.id) ?? "", url: item.url ?? null,
          metadata: item.metadata, acl_scopes: Array.isArray(item.metadata.aclScopes) ? item.metadata.aclScopes : [item.visibility === "public" ? "public" : "company"] }));
        const payload = JSON.stringify(rows);
        await client.query(`UPDATE artifacts a SET is_current=false FROM jsonb_to_recordset($1::jsonb)
          AS x(source text,external_id text,local_key text) WHERE a.tenant_id=$2 AND a.company_id=$3
          AND a.source=x.source AND a.external_id=x.external_id AND a.local_key<>x.local_key`, [payload, this.tenantId, companyId]);
        await client.query(`INSERT INTO artifacts(id,tenant_id,company_id,local_key,source,external_id,version,occurred_at,collected_at,
          visibility,title,object_key,content_hash,url,metadata,acl_scopes,is_current)
          SELECT x.id,$2,$3,x.local_key,x.source,x.external_id,x.version,x.occurred_at,x.collected_at,x.visibility,x.title,
            x.object_key,x.content_hash,x.url,x.metadata,x.acl_scopes,true FROM jsonb_to_recordset($1::jsonb)
          AS x(id uuid,local_key text,source text,external_id text,version text,occurred_at timestamptz,collected_at timestamptz,
            visibility text,title text,object_key text,content_hash text,url text,metadata jsonb,acl_scopes text[])
          ON CONFLICT(tenant_id,company_id,source,external_id,version) DO UPDATE SET collected_at=excluded.collected_at,
            title=excluded.title,object_key=excluded.object_key,content_hash=excluded.content_hash,url=excluded.url,
            metadata=excluded.metadata,acl_scopes=excluded.acl_scopes,is_current=true,deleted_at=NULL`, [payload, this.tenantId, companyId]);
      });
    }
  }

  async replaceEvidence(company: CompanyConfig, items: Array<{ artifactId: string; extractorVersion: string; records: EvidenceRecord[] }>): Promise<void> {
    if (items.length === 0) return;
    for (let offset = 0; offset < items.length; offset += 250) {
      const batch = items.slice(offset, offset + 250);
      await this.transaction(async client => {
        const companyId = await this.ensureCompany(client, company);
        const artifactUuids = batch.map(item => stableUuid("artifact", this.tenantId, company.id, item.artifactId));
        await client.query("DELETE FROM evidence WHERE tenant_id=$1 AND company_id=$2 AND artifact_id=ANY($3::uuid[])", [this.tenantId, companyId, artifactUuids]);
        const rows = batch.flatMap(item => item.records.map(record => ({ id: stableUuid("evidence", this.tenantId, company.id, record.id), external_key: record.id,
          artifact_id: stableUuid("artifact", this.tenantId, company.id, item.artifactId), source: record.source, visibility: record.visibility,
          kind: record.kind, claim: record.claim, quote: record.quote, tags: record.tags, product_line: record.productLine ?? null, segment: record.segment ?? null,
          confidence: record.confidence, authority: record.authority ?? 0.5, lifecycle: record.lifecycle ?? "unknown",
          valid_from: record.validFrom ?? null, valid_to: record.validTo ?? null, occurred_at: record.occurredAt,
          extractor_version: record.extractorVersion, safe_use: record.safeUse,
          acl_scopes: record.aclScopes ?? [record.visibility === "public" ? "public" : "company"],
          buyer_intent: record.buyerIntent ?? "irrelevant" })));
        if (rows.length > 0) await client.query(`INSERT INTO evidence(id,tenant_id,company_id,external_key,artifact_id,source,visibility,kind,
          claim,quote,tags,product_line,segment,confidence,authority,lifecycle,valid_from,valid_to,occurred_at,extractor_version,safe_use,acl_scopes,buyer_intent)
          SELECT x.id,$2,$3,x.external_key,x.artifact_id,x.source,x.visibility,x.kind,x.claim,x.quote,x.tags,x.product_line,x.segment,
            x.confidence,x.authority,x.lifecycle,x.valid_from,x.valid_to,x.occurred_at,x.extractor_version,x.safe_use,x.acl_scopes,x.buyer_intent
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,external_key text,artifact_id uuid,source text,visibility text,kind text,
            claim text,quote text,tags text[],product_line text,segment text,confidence real,authority real,lifecycle text,valid_from timestamptz,
            valid_to timestamptz,occurred_at timestamptz,extractor_version text,safe_use text,acl_scopes text[],buyer_intent text)`,
        [JSON.stringify(rows), this.tenantId, companyId]);
        await client.query("UPDATE artifacts SET extracted_version=$1 WHERE tenant_id=$2 AND company_id=$3 AND id=ANY($4::uuid[])",
          [batch[0]?.extractorVersion ?? "unknown", this.tenantId, companyId, artifactUuids]);
      });
    }
  }

  async searchEvidence(input: { companyKey: string; query: string; kinds: string[]; scopes: string[]; limit?: number; embedding?: StoredEmbedding }): Promise<Array<{ evidenceId: string; score: number }>> {
    return this.transaction(async client => {
      if (input.embedding && input.embedding.dimensions !== 768) {
        throw new Error(`The installed pgvector index supports 768 dimensions, received ${input.embedding.dimensions}`);
      }
      const vector = input.embedding ? `[${input.embedding.values.join(",")}]` : null;
      const result = await client.query<{ external_key: string; score: number }>(`WITH q AS (
          SELECT websearch_to_tsquery('english', $3) AS terms
        ) SELECT e.external_key,
          (ts_rank_cd(e.search_document,q.terms) * 0.45 + similarity(e.claim,$3) * 0.2 + e.confidence * 0.15 + e.authority * 0.1
            + CASE WHEN $7::vector(768) IS NULL OR ee.embedding IS NULL THEN 0
              ELSE (1 - (ee.embedding::vector(768) <=> $7::vector(768))) * 0.35 END
            + exp(-greatest(0,extract(epoch from (now()-e.occurred_at))/86400)/365) * 0.1)::real AS score
        FROM evidence e JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
          JOIN artifacts a ON a.id=e.artifact_id AND a.tenant_id=e.tenant_id
          LEFT JOIN evidence_embeddings ee ON ee.tenant_id=e.tenant_id AND ee.evidence_id=e.id
            AND ee.provider=$8 AND ee.model=$9 CROSS JOIN q
        WHERE e.tenant_id=$1 AND c.external_key=$2 AND e.external_key IS NOT NULL AND e.kind=ANY($4::text[])
          AND e.acl_scopes && $5::text[] AND e.safe_use<>'never-expose'
          AND e.lifecycle NOT IN ('deprecated','superseded')
          AND a.is_current AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM evidence_relations r WHERE r.tenant_id=e.tenant_id AND r.from_evidence_id=e.id AND r.relation='duplicates')
          AND NOT (e.kind IN ('capability','change') AND e.lifecycle IN ('planned','investigating'))
          AND (e.valid_from IS NULL OR e.valid_from<=now()) AND (e.valid_to IS NULL OR e.valid_to>now())
          AND (e.search_document @@ q.terms OR similarity(e.claim,$3)>0.08 OR ($7::vector(768) IS NOT NULL AND ee.embedding IS NOT NULL))
        ORDER BY score DESC LIMIT $6`,
      [this.tenantId, input.companyKey, input.query, input.kinds, input.scopes, input.limit ?? 20, vector,
        input.embedding?.provider ?? "", input.embedding?.model ?? ""]);
      return result.rows.map(row => ({ evidenceId: row.external_key, score: Number(row.score) }));
    });
  }

  async evidenceMissingEmbeddings(companyKey: string, provider: string, model: string, limit: number): Promise<Array<{ id: string; claim: string; source: EvidenceRecord["source"]; kind: EvidenceRecord["kind"]; safeUse: EvidenceRecord["safeUse"]; tags: string[]; buyerIntent?: EvidenceRecord["buyerIntent"] }>> {
    return this.transaction(async client => (await client.query<{ id: string; claim: string; source: EvidenceRecord["source"]; kind: EvidenceRecord["kind"]; safe_use: EvidenceRecord["safeUse"]; tags: string[]; buyer_intent: EvidenceRecord["buyerIntent"] | null }>(`SELECT e.id::text,e.claim,e.source,e.kind,e.safe_use,e.tags,e.buyer_intent FROM evidence e
      JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id JOIN artifacts a ON a.id=e.artifact_id
      LEFT JOIN evidence_embeddings ee ON ee.tenant_id=e.tenant_id AND ee.evidence_id=e.id AND ee.provider=$3 AND ee.model=$4
      WHERE e.tenant_id=$1 AND c.external_key=$2 AND ee.evidence_id IS NULL AND a.is_current AND a.deleted_at IS NULL
      AND e.safe_use<>'never-expose' ORDER BY e.occurred_at DESC LIMIT $5`, [this.tenantId, companyKey, provider, model, limit])).rows.map(row => ({
        id: row.id, claim: row.claim, source: row.source, kind: row.kind, safeUse: row.safe_use, tags: row.tags,
        ...(row.buyer_intent ? { buyerIntent: row.buyer_intent } : {}),
      })));
  }

  async contextCounts(companyKey: string): Promise<{ artifacts: number; evidence: number }> {
    return this.transaction(async client => {
      const result = await client.query<{ artifacts: string; evidence: string }>(`SELECT
        (SELECT count(*)::text FROM artifacts a JOIN companies c ON c.id=a.company_id AND c.tenant_id=a.tenant_id
          WHERE a.tenant_id=$1 AND c.external_key=$2 AND a.is_current AND a.deleted_at IS NULL) artifacts,
        (SELECT count(*)::text FROM evidence e JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
          JOIN artifacts a ON a.id=e.artifact_id WHERE e.tenant_id=$1 AND c.external_key=$2 AND a.is_current AND a.deleted_at IS NULL) evidence`,
      [this.tenantId, companyKey]);
      return { artifacts: Number(result.rows[0]?.artifacts ?? 0), evidence: Number(result.rows[0]?.evidence ?? 0) };
    });
  }

  async evidenceCountForExtractor(companyKey: string, extractorVersion: string): Promise<number> {
    return this.transaction(async client => Number((await client.query<{ count: string }>(`SELECT count(*)::text count FROM evidence e
      JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id JOIN artifacts a ON a.id=e.artifact_id
      WHERE e.tenant_id=$1 AND c.external_key=$2 AND e.extractor_version=$3 AND a.is_current AND a.deleted_at IS NULL`,
      [this.tenantId, companyKey, extractorVersion])).rows[0]?.count ?? 0));
  }

  async refreshEvidenceRelations(companyKey: string): Promise<{ duplicates: number; supersedes: number }> {
    return this.transaction(async client => {
      const company = await client.query<{ id: string }>("SELECT id FROM companies WHERE tenant_id=$1 AND external_key=$2", [this.tenantId, companyKey]);
      const companyId = company.rows[0]?.id;
      if (!companyId) return { duplicates: 0, supersedes: 0 };
      await client.query(`DELETE FROM evidence_relations r USING evidence e WHERE r.tenant_id=$1
        AND r.from_evidence_id=e.id AND e.company_id=$2 AND r.relation IN ('duplicates','supersedes')`, [this.tenantId, companyId]);
      const duplicates = await client.query(`WITH ranked AS (
          SELECT e.id,row_number() OVER(PARTITION BY md5(lower(e.claim)) ORDER BY e.authority DESC,e.confidence DESC,e.occurred_at DESC,e.id) rn,
            first_value(e.id) OVER(PARTITION BY md5(lower(e.claim)) ORDER BY e.authority DESC,e.confidence DESC,e.occurred_at DESC,e.id) canonical
          FROM evidence e JOIN artifacts a ON a.id=e.artifact_id WHERE e.tenant_id=$1 AND e.company_id=$2 AND a.is_current AND a.deleted_at IS NULL
        ) INSERT INTO evidence_relations(tenant_id,from_evidence_id,to_evidence_id,relation,confidence)
          SELECT $1,id,canonical,'duplicates',1 FROM ranked WHERE rn>1 ON CONFLICT DO NOTHING`, [this.tenantId, companyId]);
      const supersedes = await client.query(`WITH pairs AS (
          SELECT olde.id old_id,newe.id new_id,row_number() OVER(PARTITION BY olde.id ORDER BY newa.occurred_at DESC,newe.confidence DESC) rn
          FROM artifacts olda JOIN artifacts newa ON newa.tenant_id=olda.tenant_id AND newa.company_id=olda.company_id
            AND newa.source=olda.source AND newa.external_id=olda.external_id AND newa.is_current AND newa.deleted_at IS NULL
          JOIN evidence olde ON olde.artifact_id=olda.id JOIN evidence newe ON newe.artifact_id=newa.id AND newe.kind=olde.kind
          WHERE olda.tenant_id=$1 AND olda.company_id=$2 AND NOT olda.is_current AND olda.id<>newa.id
        ) INSERT INTO evidence_relations(tenant_id,from_evidence_id,to_evidence_id,relation,confidence)
          SELECT $1,old_id,new_id,'supersedes',0.95 FROM pairs WHERE rn=1 ON CONFLICT DO NOTHING`, [this.tenantId, companyId]);
      return { duplicates: duplicates.rowCount ?? 0, supersedes: supersedes.rowCount ?? 0 };
    });
  }

  async writeEmbeddings(items: Array<{ id: string; embedding: number[]; inputHash: string }>, provider: string, model: string, dimensions: number): Promise<void> {
    if (items.length === 0) return;
    if (items.some(item => item.embedding.length !== dimensions)) throw new Error(`Embedding batch does not match declared ${dimensions} dimensions`);
    await this.transaction(async client => {
      const rows = items.map(item => ({ id: item.id, embedding: `[${item.embedding.join(",")}]`, input_hash: item.inputHash }));
      await client.query(`INSERT INTO evidence_embeddings(tenant_id,evidence_id,provider,model,dimensions,embedding,input_hash)
        SELECT $2,x.id,$3,$4,$5,x.embedding::vector,x.input_hash FROM jsonb_to_recordset($1::jsonb)
          AS x(id uuid,embedding text,input_hash text)
        ON CONFLICT(tenant_id,evidence_id,provider,model) DO UPDATE SET dimensions=excluded.dimensions,
          embedding=excluded.embedding,input_hash=excluded.input_hash,embedded_at=now()`,
      [JSON.stringify(rows), this.tenantId, provider, model, dimensions]);
    });
  }

  async evidenceTagsForCompany(companyKey: string): Promise<string[]> {
    return this.transaction(async client => (await client.query<{ tag: string }>(`SELECT DISTINCT unnest(e.tags) tag
      FROM evidence e JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
      JOIN artifacts a ON a.id=e.artifact_id AND a.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND c.external_key=$2 AND a.is_current AND a.deleted_at IS NULL ORDER BY tag`,
    [this.tenantId, companyKey])).rows.map(row => row.tag));
  }

  async evidenceByExternalIds(ids: string[]): Promise<EvidenceRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    return this.transaction(async client => (await client.query<Record<string, unknown>>(`SELECT e.external_key,e.source,e.visibility,e.kind,
      e.claim,e.quote,e.tags,e.product_line,e.segment,e.confidence,e.authority,e.lifecycle,e.valid_from,e.valid_to,e.occurred_at,
      e.extractor_version,e.safe_use,e.acl_scopes,e.buyer_intent,a.local_key artifact_key,c.external_key company_key
      FROM evidence e JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
      JOIN artifacts a ON a.id=e.artifact_id AND a.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND e.external_key=ANY($2::text[]) AND a.is_current AND a.deleted_at IS NULL`,
    [this.tenantId, unique])).rows.map(row => ({
      id: String(row.external_key), companyId: String(row.company_key), artifactId: String(row.artifact_key),
      source: String(row.source) as EvidenceRecord["source"], visibility: String(row.visibility) as EvidenceRecord["visibility"],
      kind: String(row.kind) as EvidenceRecord["kind"], claim: String(row.claim), quote: String(row.quote ?? ""),
      tags: row.tags as string[], ...(row.product_line ? { productLine: String(row.product_line) } : {}),
      ...(row.segment ? { segment: String(row.segment) } : {}), confidence: Number(row.confidence),
      authority: Number(row.authority), lifecycle: String(row.lifecycle) as NonNullable<EvidenceRecord["lifecycle"]>,
      ...(row.valid_from ? { validFrom: new Date(String(row.valid_from)).toISOString() } : {}),
      ...(row.valid_to ? { validTo: new Date(String(row.valid_to)).toISOString() } : {}),
      occurredAt: new Date(String(row.occurred_at)).toISOString(), extractorVersion: String(row.extractor_version),
      safeUse: String(row.safe_use) as EvidenceRecord["safeUse"], aclScopes: row.acl_scopes as string[],
      buyerIntent: String(row.buyer_intent) as NonNullable<EvidenceRecord["buyerIntent"]>,
    })));
  }

  async evidenceForCompany(companyKey: string): Promise<EvidenceRecord[]> {
    const ids = await this.transaction(async client => (await client.query<{ external_key: string }>(`SELECT e.external_key FROM evidence e
      JOIN companies c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
      JOIN artifacts a ON a.id=e.artifact_id AND a.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND c.external_key=$2 AND e.external_key IS NOT NULL
        AND a.is_current AND a.deleted_at IS NULL
        AND e.lifecycle NOT IN ('deprecated','superseded')
        AND (e.valid_from IS NULL OR e.valid_from<=now()) AND (e.valid_to IS NULL OR e.valid_to>now())`,
    [this.tenantId, companyKey])).rows.map(row => row.external_key));
    return this.evidenceByExternalIds(ids);
  }

  async artifactsByLocalKeys(keys: string[]): Promise<SourceArtifact[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    return this.transaction(async client => (await client.query<Record<string, unknown>>(`SELECT a.local_key,a.source,a.external_id,a.version,
      a.occurred_at,a.collected_at,a.visibility,a.title,a.url,a.metadata,c.external_key company_key
      FROM artifacts a JOIN companies c ON c.id=a.company_id AND c.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 AND a.local_key=ANY($2::text[]) AND a.is_current AND a.deleted_at IS NULL`,
    [this.tenantId, unique])).rows.map(row => ({
      id: String(row.local_key), companyId: String(row.company_key), source: String(row.source) as SourceArtifact["source"],
      externalId: String(row.external_id), version: String(row.version), occurredAt: new Date(String(row.occurred_at)).toISOString(),
      collectedAt: new Date(String(row.collected_at)).toISOString(), visibility: String(row.visibility) as SourceArtifact["visibility"],
      title: String(row.title), content: "", ...(row.url ? { url: String(row.url) } : {}), metadata: row.metadata as Record<string, unknown>,
    })));
  }

  async latestPublishedResults(): Promise<RunResult[]> {
    return this.transaction(async client => (await client.query<{ result: RunResult }>(`SELECT DISTINCT ON (r.company_id) r.result
      FROM runs r WHERE r.tenant_id=$1 AND r.published AND r.status='complete' AND r.result IS NOT NULL
      ORDER BY r.company_id,r.completed_at DESC`, [this.tenantId])).rows.map(row => row.result));
  }

  async latestPublishedResult(companyKey: string): Promise<RunResult | undefined> {
    return this.transaction(async client => (await client.query<{ result: RunResult }>(`SELECT r.result FROM runs r
      JOIN companies c ON c.id=r.company_id AND c.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND c.external_key=$2 AND r.published AND r.status='complete' AND r.result IS NOT NULL
      ORDER BY r.completed_at DESC LIMIT 1`, [this.tenantId, companyKey])).rows[0]?.result);
  }

  async traceForRun(runId: string): Promise<TraceEvent[]> {
    return this.transaction(async client => (await client.query<Record<string, unknown>>(`SELECT t.at,t.stage,t.action,t.subject_id,t.data,
      c.external_key company_key FROM trace_events t JOIN companies c ON c.id=t.company_id AND c.tenant_id=t.tenant_id
      WHERE t.tenant_id=$1 AND t.run_id=$2 ORDER BY t.sequence`, [this.tenantId, stableUuid("run", runId)])).rows.map(row => ({
        runId, companyId: String(row.company_key), at: new Date(String(row.at)).toISOString(), stage: String(row.stage),
        action: String(row.action), ...(row.subject_id ? { subjectId: String(row.subject_id) } : {}), data: row.data as Record<string, unknown>,
      })));
  }

  async getModelCache<T>(key: string): Promise<T | undefined> {
    return this.transaction(async client => (await client.query<{ value: T }>(
      "SELECT value FROM model_cache WHERE tenant_id=$1 AND cache_key=$2", [this.tenantId, key])).rows[0]?.value);
  }

  async setModelCache(key: string, provider: string, operation: string, value: unknown): Promise<void> {
    await this.transaction(async client => { await client.query(`INSERT INTO model_cache(tenant_id,cache_key,provider,operation,value)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,cache_key) DO UPDATE SET value=excluded.value,
      provider=excluded.provider,operation=excluded.operation,created_at=now()`,
    [this.tenantId, key, provider, operation, JSON.stringify(value)]); });
  }

  async putSharedObject(key: string, encryptedPayload: Buffer, contentHash: string): Promise<void> {
    await this.transaction(async client => { await client.query(`INSERT INTO shared_objects(tenant_id,object_key,encrypted_payload,content_hash)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,object_key) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,
      content_hash=excluded.content_hash,updated_at=now()`, [this.tenantId, key, encryptedPayload, contentHash]); });
  }

  async getSharedObject(key: string): Promise<Buffer> {
    return this.transaction(async client => {
      const row = (await client.query<{ encrypted_payload: Buffer }>(
        "SELECT encrypted_payload FROM shared_objects WHERE tenant_id=$1 AND object_key=$2", [this.tenantId, key])).rows[0];
      if (!row) throw new Error(`Shared object not found: ${key}`);
      return row.encrypted_payload;
    });
  }

  async deleteSharedObject(key: string): Promise<void> {
    await this.transaction(async client => { await client.query(
      "DELETE FROM shared_objects WHERE tenant_id=$1 AND object_key=$2", [this.tenantId, key]); });
  }

  async recordCanaryReport<T extends { id: string; startedAt: string; completedAt: string; passed: boolean }>(report: T): Promise<void> {
    await this.transaction(async client => { await client.query(`INSERT INTO canary_reports(
      tenant_id,report_id,started_at,completed_at,passed,report)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,report_id) DO UPDATE SET
      started_at=excluded.started_at,completed_at=excluded.completed_at,passed=excluded.passed,report=excluded.report`,
    [this.tenantId, report.id, report.startedAt, report.completedAt, report.passed, JSON.stringify(report)]); });
  }

  async latestCanaryReport<T>(): Promise<T | undefined> {
    return this.transaction(async client => (await client.query<{ report: T }>(`SELECT report FROM canary_reports
      WHERE tenant_id=$1 ORDER BY completed_at DESC LIMIT 1`, [this.tenantId])).rows[0]?.report);
  }

  async canaryReports<T>(limit = 20): Promise<T[]> {
    return this.transaction(async client => (await client.query<{ report: T }>(`SELECT report FROM canary_reports
      WHERE tenant_id=$1 ORDER BY completed_at DESC LIMIT $2`, [this.tenantId, limit])).rows.map(row => row.report));
  }

  async enqueueJob(job: { id: string; company: CompanyConfig; fixtures: boolean; createdAt: string }): Promise<RunJob> {
    return this.transaction(async client => {
      const companyId = await this.ensureCompany(client, job.company);
      const existing = await client.query("SELECT * FROM run_jobs WHERE tenant_id=$1 AND company_id=$2 AND status IN ('queued','running') ORDER BY created_at LIMIT 1", [this.tenantId, companyId]);
      if (existing.rows[0]) return rowToJob(existing.rows[0] as Record<string, unknown>);
      const result = await client.query(`INSERT INTO run_jobs(id,tenant_id,company_id,status,payload,created_at)
        VALUES($1,$2,$3,'queued',$4::jsonb,$5) RETURNING *`,
      [job.id, this.tenantId, companyId, JSON.stringify({ company: job.company, fixtures: job.fixtures }), job.createdAt]);
      return rowToJob(result.rows[0] as Record<string, unknown>);
    });
  }

  async claimJob(owner: string, now: Date, leaseMs: number, publicOnly = false): Promise<RunJob | undefined> {
    return this.transaction(async client => {
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const result = await client.query(`WITH candidate AS (
          SELECT id FROM run_jobs WHERE tenant_id=$1 AND (
            (status='queued' AND available_at <= $2) OR (status='running' AND lease_expires_at < $2)
          ) AND ($5::boolean=false OR payload->>'fixtures'='false')
          ORDER BY CASE WHEN payload->>'fixtures'='false' THEN 0 ELSE 1 END, created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE run_jobs j SET status='running',started_at=coalesce(j.started_at,$2),lease_owner=$3,
          lease_expires_at=$4,attempts=j.attempts+1 FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
      [this.tenantId, now.toISOString(), owner, leaseExpiresAt, publicOnly]);
      return result.rows[0] ? rowToJob(result.rows[0] as Record<string, unknown>) : undefined;
    });
  }

  async renewJobLease(id: string, owner: string, now: Date, leaseMs: number): Promise<boolean> {
    return this.transaction(async client => (await client.query(
      "UPDATE run_jobs SET lease_expires_at=$1 WHERE tenant_id=$2 AND id=$3 AND status='running' AND lease_owner=$4",
      [new Date(now.getTime() + leaseMs).toISOString(), this.tenantId, id, owner],
    )).rowCount === 1);
  }

  async finishJob(id: string, owner: string, result: RunResult): Promise<void> {
    await this.transaction(async client => {
      const current = await client.query<{ attempts: number; max_attempts: number; cancellation_requested_at: Date | null }>(
        "SELECT attempts,max_attempts,cancellation_requested_at FROM run_jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.tenantId, id]);
      const row = current.rows[0];
      if (!row) return;
      if (!row.cancellation_requested_at && result.status === "failed" && result.failure?.retryable !== false && row.attempts < row.max_attempts) {
        const backoffMs = Math.min(300_000, 5_000 * 2 ** Math.max(0, row.attempts - 1));
        await client.query(`UPDATE run_jobs SET status='queued',available_at=$1,result=$2::jsonb,error=$3,
          lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$4 AND id=$5 AND lease_owner=$6`,
        [new Date(Date.now() + backoffMs).toISOString(), JSON.stringify(result), result.error ?? null, this.tenantId, id, owner]);
        return;
      }
      await client.query(`UPDATE run_jobs SET status=$1,completed_at=$2,result=$3::jsonb,error=$4,
        lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$5 AND id=$6 AND lease_owner=$7`,
      [row.cancellation_requested_at ? "cancelled" : result.status === "failed" ? "failed" : "complete",
        result.completedAt, JSON.stringify(result), result.error ?? null, this.tenantId, id, owner]);
    });
  }

  async requestJobCancellation(id: string, at = new Date()): Promise<boolean> {
    return this.transaction(async client => {
      const result = await client.query(`UPDATE run_jobs SET cancellation_requested_at=$1,
        status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
        completed_at=CASE WHEN status='queued' THEN $1 ELSE completed_at END
        WHERE tenant_id=$2 AND id=$3 AND status IN ('queued','running')`, [at.toISOString(), this.tenantId, id]);
      return result.rowCount === 1;
    });
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    return this.transaction(async client => Boolean((await client.query<{ cancellation_requested_at: Date | null }>(
      "SELECT cancellation_requested_at FROM run_jobs WHERE tenant_id=$1 AND id=$2", [this.tenantId, id])).rows[0]?.cancellation_requested_at));
  }

  async jobById(id: string): Promise<RunJob | undefined> {
    return this.transaction(async client => {
      const row = (await client.query("SELECT * FROM run_jobs WHERE tenant_id=$1 AND id=$2", [this.tenantId, id])).rows[0];
      return row ? rowToJob(row as Record<string, unknown>) : undefined;
    });
  }

  async activeJobCompanyIds(): Promise<string[]> {
    return this.transaction(async client => (await client.query<{ external_key: string }>(`SELECT DISTINCT c.external_key
      FROM run_jobs j JOIN companies c ON c.id=j.company_id AND c.tenant_id=j.tenant_id
      WHERE j.tenant_id=$1 AND j.status IN ('queued','running') ORDER BY c.external_key`, [this.tenantId])).rows.map(row => row.external_key));
  }

  async acquireLock(name: string, owner: string, now: Date, ttlMs: number): Promise<boolean> {
    return this.transaction(async client => {
      await client.query("DELETE FROM scheduler_locks WHERE tenant_id=$1 AND name=$2 AND expires_at < $3", [this.tenantId, name, now.toISOString()]);
      const result = await client.query(`INSERT INTO scheduler_locks(tenant_id,name,owner,acquired_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,name) DO NOTHING RETURNING name`,
      [this.tenantId, name, owner, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()]);
      return result.rowCount === 1;
    });
  }

  async renewLock(name: string, owner: string, now: Date, ttlMs: number): Promise<boolean> {
    return this.transaction(async client => (await client.query(`UPDATE scheduler_locks SET expires_at=$1
      WHERE tenant_id=$2 AND name=$3 AND owner=$4`, [new Date(now.getTime() + ttlMs).toISOString(), this.tenantId, name, owner])).rowCount === 1);
  }

  async releaseLock(name: string, owner: string): Promise<void> {
    await this.transaction(async client => { await client.query("DELETE FROM scheduler_locks WHERE tenant_id=$1 AND name=$2 AND owner=$3", [this.tenantId, name, owner]); });
  }

  async lastSuccessfulRunAt(companyKey: string): Promise<string | undefined> {
    return this.transaction(async client => {
      const result = await client.query<{ completed_at: Date }>(`SELECT r.completed_at FROM runs r JOIN companies c ON c.id=r.company_id AND c.tenant_id=r.tenant_id
        WHERE r.tenant_id=$1 AND c.external_key=$2 AND r.status IN ('complete','insufficient_evidence')
        ORDER BY r.completed_at DESC LIMIT 1`, [this.tenantId, companyKey]);
      return result.rows[0]?.completed_at?.toISOString();
    });
  }

  async sourceHealth(companyKey: string): Promise<SourceHealth[]> {
    return this.transaction(async client => (await client.query<Record<string, unknown>>(`SELECT s.source,s.status,s.cursor,
      s.last_attempt_at,s.last_success_at,s.last_error FROM source_connections s
      JOIN companies c ON c.id=s.company_id AND c.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND c.external_key=$2 ORDER BY s.source`, [this.tenantId, companyKey])).rows.map(row => {
        const cursor = (row.cursor ?? {}) as Record<string, unknown>;
        return { companyId: companyKey, source: String(row.source) as SourceHealth["source"], status: String(row.status) as SourceHealth["status"],
          checkedAt: new Date(String(row.last_attempt_at ?? row.last_success_at)).toISOString(),
          collectedArtifacts: Number(cursor.collectedArtifacts ?? 0), changedArtifacts: Number(cursor.changedArtifacts ?? 0),
          ...(row.last_success_at ? { lastSuccessAt: new Date(String(row.last_success_at)).toISOString() } : {}),
          ...(row.last_error ? { error: String(row.last_error) } : {}) };
      }));
  }

  private async transaction<T>(execute: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]);
      // The supplied database owner can bypass RLS. Drop privileges inside every
      // application transaction so tenant policies are actually enforced.
      await client.query("SET LOCAL ROLE promptgen_app");
      await client.query("INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name", [this.tenantId, this.tenantName]);
      const value = await execute(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureCompany(client: PoolClient, company: CompanyConfig): Promise<string> {
    const id = stableUuid("company", this.tenantId, company.id);
    await client.query(`INSERT INTO companies(id,tenant_id,external_key,name,domain,category)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id,external_key) DO UPDATE SET name=excluded.name,domain=excluded.domain,category=excluded.category`,
    [id, this.tenantId, company.id, company.name, company.domain, company.category]);
    return id;
  }
}

function rowToJob(row: Record<string, unknown>): RunJob {
  const payload = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as { company: CompanyConfig; fixtures: boolean };
  const result = row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) as RunResult : undefined;
  return {
    id: String(row.id), companyId: payload.company.id, status: String(row.status) as RunJob["status"], company: payload.company,
    fixtures: Boolean(payload.fixtures), createdAt: new Date(String(row.created_at)).toISOString(),
    ...(typeof row.attempts === "number" ? { attempts: row.attempts } : {}),
    ...(row.started_at ? { startedAt: new Date(String(row.started_at)).toISOString() } : {}),
    ...(row.completed_at ? { completedAt: new Date(String(row.completed_at)).toISOString() } : {}),
    ...(result ? { result } : {}), ...(row.error ? { error: String(row.error) } : {}),
  };
}
