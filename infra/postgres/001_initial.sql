BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_key text NOT NULL,
  name text NOT NULL,
  domain text NOT NULL,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_key),
  UNIQUE (tenant_id, domain),
  UNIQUE (tenant_id, id)
);

CREATE TABLE source_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL,
  encrypted_credentials bytea,
  cursor jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('healthy','empty','degraded','disabled')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  UNIQUE (tenant_id, company_id, source)
);
ALTER TABLE source_connections ADD CONSTRAINT source_connections_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL,
  external_id text NOT NULL,
  version text NOT NULL,
  occurred_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public','private','synthetic')),
  title text NOT NULL,
  object_key text NOT NULL,
  content_hash text NOT NULL,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}',
  acl_scopes text[] NOT NULL DEFAULT ARRAY['company'],
  extracted_version text,
  is_current boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  UNIQUE (tenant_id, company_id, source, external_id, version),
  UNIQUE (tenant_id, id)
);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;
CREATE INDEX artifacts_current_source ON artifacts (tenant_id, company_id, source, occurred_at DESC) WHERE is_current AND deleted_at IS NULL;
CREATE INDEX artifacts_acl ON artifacts USING gin (acl_scopes);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  source text NOT NULL,
  visibility text NOT NULL,
  kind text NOT NULL,
  claim text NOT NULL,
  quote_start integer,
  quote_end integer,
  tags text[] NOT NULL DEFAULT '{}',
  product_line text,
  segment text,
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  authority real NOT NULL CHECK (authority BETWEEN 0 AND 1),
  lifecycle text NOT NULL CHECK (lifecycle IN ('confirmed','planned','investigating','deprecated','superseded','unknown')),
  valid_from timestamptz,
  valid_to timestamptz,
  occurred_at timestamptz NOT NULL,
  extractor_version text NOT NULL,
  safe_use text NOT NULL CHECK (safe_use IN ('public','derive-only','aggregate-only','never-expose')),
  acl_scopes text[] NOT NULL DEFAULT ARRAY['company'],
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(claim,''))) STORED,
  embedding vector(1536),
  UNIQUE (tenant_id, id)
);
CREATE INDEX evidence_lexical ON evidence USING gin (search_document);
CREATE INDEX evidence_tags ON evidence USING gin (tags);
CREATE INDEX evidence_vector ON evidence USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
CREATE INDEX evidence_filter ON evidence (tenant_id, company_id, kind, occurred_at DESC);
CREATE INDEX evidence_acl ON evidence USING gin (acl_scopes);
ALTER TABLE evidence ADD CONSTRAINT evidence_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE evidence ADD CONSTRAINT evidence_artifact_tenant
  FOREIGN KEY (tenant_id, artifact_id) REFERENCES artifacts(tenant_id, id) ON DELETE CASCADE;

CREATE TABLE evidence_relations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_evidence_id uuid NOT NULL,
  to_evidence_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('duplicates','contradicts','supersedes','supports')),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, from_evidence_id, to_evidence_id, relation),
  FOREIGN KEY (tenant_id, from_evidence_id) REFERENCES evidence(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_evidence_id) REFERENCES evidence(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','complete','insufficient_evidence','failed')),
  provider text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  result jsonb,
  error text,
  UNIQUE (tenant_id, id)
);
ALTER TABLE runs ADD CONSTRAINT runs_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;

CREATE TABLE run_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued','running','complete','failed','cancelled')),
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text
);
CREATE UNIQUE INDEX one_active_company_job ON run_jobs (tenant_id, company_id) WHERE status IN ('queued','running');
CREATE INDEX runnable_jobs ON run_jobs (available_at, created_at) WHERE status = 'queued';
ALTER TABLE run_jobs ADD CONSTRAINT run_jobs_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;

CREATE TABLE trace_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  stage text NOT NULL,
  action text NOT NULL,
  subject_id text,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX trace_run_sequence ON trace_events (tenant_id, run_id, sequence);
ALTER TABLE trace_events ADD CONSTRAINT trace_company_tenant
  FOREIGN KEY (tenant_id, company_id) REFERENCES companies(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE trace_events ADD CONSTRAINT trace_run_tenant
  FOREIGN KEY (tenant_id, run_id) REFERENCES runs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE source_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_relations FORCE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
ALTER TABLE run_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE trace_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON tenants USING (id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_companies ON companies USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_connections ON source_connections USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_artifacts ON artifacts USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_evidence ON evidence USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_evidence_relations ON evidence_relations USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_runs ON runs USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_jobs ON run_jobs USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE POLICY tenant_traces ON trace_events USING (tenant_id = current_setting('app.tenant_id')::uuid);

COMMIT;
