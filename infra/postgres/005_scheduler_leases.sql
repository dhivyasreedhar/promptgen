BEGIN;

CREATE TABLE scheduler_locks (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  owner text NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

ALTER TABLE scheduler_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduler_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scheduler_locks ON scheduler_locks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduler_locks TO promptgen_app;

COMMIT;
