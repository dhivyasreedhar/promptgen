BEGIN;

CREATE TABLE tracking_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  text text NOT NULL,
  archetype text NOT NULL,
  evidence_keys text[] NOT NULL DEFAULT '{}',
  score real NOT NULL,
  active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  latest_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  UNIQUE(tenant_id, company_id, stable_key),
  UNIQUE(tenant_id, id)
);
ALTER TABLE tracking_prompts ADD CONSTRAINT tracking_prompts_company_tenant
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id) ON DELETE CASCADE;

CREATE TABLE prompt_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prompt_id uuid NOT NULL REFERENCES tracking_prompts(id) ON DELETE CASCADE,
  verdict text NOT NULL CHECK(verdict IN ('approved','rejected','edited')),
  edited_text text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_eval_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prompt_id uuid NOT NULL REFERENCES tracking_prompts(id) ON DELETE CASCADE,
  agent text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  company_mentioned boolean NOT NULL,
  cited_urls jsonb NOT NULL DEFAULT '[]',
  competitors text[] NOT NULL DEFAULT '{}',
  answer_hash text,
  UNIQUE(tenant_id,prompt_id,agent,evaluated_at)
);

ALTER TABLE tracking_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_prompts FORCE ROW LEVEL SECURITY;
ALTER TABLE prompt_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_eval_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_tracking_prompts ON tracking_prompts USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_prompt_feedback ON prompt_feedback USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_agent_eval ON agent_eval_observations USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON tracking_prompts,prompt_feedback,agent_eval_observations TO promptgen_app;

COMMIT;
