BEGIN;

DROP POLICY tenant_self ON tenants;
DROP POLICY tenant_companies ON companies;
DROP POLICY tenant_connections ON source_connections;
DROP POLICY tenant_artifacts ON artifacts;
DROP POLICY tenant_evidence ON evidence;
DROP POLICY tenant_evidence_relations ON evidence_relations;
DROP POLICY tenant_runs ON runs;
DROP POLICY tenant_jobs ON run_jobs;
DROP POLICY tenant_traces ON trace_events;

CREATE POLICY tenant_self ON tenants USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_companies ON companies USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_connections ON source_connections USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_artifacts ON artifacts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_evidence ON evidence USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_evidence_relations ON evidence_relations USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_runs ON runs USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_jobs ON run_jobs USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_traces ON trace_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
