BEGIN;

ALTER TABLE tracking_prompts ADD COLUMN semantic_key text;
UPDATE tracking_prompts SET semantic_key=stable_key WHERE semantic_key IS NULL;
ALTER TABLE tracking_prompts ALTER COLUMN semantic_key SET NOT NULL;
CREATE INDEX tracking_prompts_semantic_active ON tracking_prompts(tenant_id,company_id,semantic_key) WHERE active;

CREATE TABLE prompt_lifecycle_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  semantic_key text NOT NULL,
  stable_key text,
  action text NOT NULL CHECK(action IN ('added','retained','removed')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX prompt_lifecycle_company_time ON prompt_lifecycle_events(tenant_id,company_id,occurred_at DESC);
ALTER TABLE prompt_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_prompt_lifecycle ON prompt_lifecycle_events
  USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON prompt_lifecycle_events TO promptgen_app;
GRANT USAGE,SELECT ON SEQUENCE prompt_lifecycle_events_id_seq TO promptgen_app;

COMMIT;
