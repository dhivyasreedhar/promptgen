BEGIN;

ALTER TABLE artifacts ADD COLUMN local_key text;
ALTER TABLE evidence ADD COLUMN external_key text;
CREATE UNIQUE INDEX artifacts_local_key ON artifacts(tenant_id, company_id, local_key) WHERE local_key IS NOT NULL;
CREATE UNIQUE INDEX evidence_external_key ON evidence(tenant_id, company_id, external_key) WHERE external_key IS NOT NULL;

COMMIT;
