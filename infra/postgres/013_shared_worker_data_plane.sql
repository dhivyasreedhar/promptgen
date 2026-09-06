BEGIN;

-- Evidence text is canonical shared state. Workers may keep SQLite as a
-- disposable scratch index, but no result depends on one machine's disk.
ALTER TABLE evidence ADD COLUMN quote text NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN published boolean NOT NULL DEFAULT false;
UPDATE runs SET published=true WHERE id IN (
  SELECT DISTINCT latest_run_id FROM tracking_prompts WHERE latest_run_id IS NOT NULL
);
CREATE INDEX runs_latest_published ON runs (tenant_id, company_id, completed_at DESC) WHERE published;

CREATE TABLE shared_objects (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  encrypted_payload bytea NOT NULL,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_key)
);

CREATE TABLE model_cache (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key text NOT NULL,
  provider text NOT NULL,
  operation text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cache_key)
);
CREATE INDEX model_cache_created ON model_cache (tenant_id, created_at DESC);

CREATE TABLE canary_reports (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  passed boolean NOT NULL,
  report jsonb NOT NULL,
  PRIMARY KEY (tenant_id, report_id)
);
CREATE INDEX canary_reports_latest ON canary_reports (tenant_id, completed_at DESC);

ALTER TABLE shared_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE model_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE canary_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE canary_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_shared_objects ON shared_objects
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_model_cache ON model_cache
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_canary_reports ON canary_reports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON shared_objects, model_cache, canary_reports TO promptgen_app;

COMMIT;
