BEGIN;
ALTER TABLE evidence ADD COLUMN buyer_intent text NOT NULL DEFAULT 'irrelevant'
  CHECK (buyer_intent IN ('discovery','evaluation','purchase','implementation','support','retention','irrelevant'));
ALTER TABLE tracking_prompts ADD COLUMN coverage jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tracking_prompts ADD COLUMN origin text NOT NULL DEFAULT 'inferred-opportunity';
ALTER TABLE tracking_prompts ADD COLUMN set_type text NOT NULL DEFAULT 'discovery' CHECK(set_type IN ('benchmark','discovery'));
ALTER TABLE tracking_prompts ADD COLUMN pinned boolean NOT NULL DEFAULT false;
ALTER TABLE prompt_feedback ADD COLUMN reason text;
ALTER TABLE prompt_feedback ADD COLUMN rule_scope text NOT NULL DEFAULT 'prompt' CHECK(rule_scope IN ('prompt','set'));
CREATE TABLE prompt_feedback_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL, reason text NOT NULL, dimension text NOT NULL, value text NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX prompt_feedback_rule_unique ON prompt_feedback_rules(tenant_id,company_id,reason,dimension,value) WHERE active;
ALTER TABLE prompt_feedback_rules ENABLE ROW LEVEL SECURITY; ALTER TABLE prompt_feedback_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_feedback_rules ON prompt_feedback_rules USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TABLE privacy_transformations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL, run_id uuid NOT NULL, evidence_key text NOT NULL, policy text NOT NULL,
  input_hash text NOT NULL, output_hash text NOT NULL, rules text[] NOT NULL, safe_preview text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE CASCADE, UNIQUE(tenant_id,run_id,evidence_key)
);
ALTER TABLE privacy_transformations ENABLE ROW LEVEL SECURITY; ALTER TABLE privacy_transformations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_privacy_transformations ON privacy_transformations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON prompt_feedback_rules,privacy_transformations TO promptgen_app;
GRANT USAGE,SELECT ON SEQUENCE prompt_feedback_rules_id_seq,privacy_transformations_id_seq TO promptgen_app;
COMMIT;
