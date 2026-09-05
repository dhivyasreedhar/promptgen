BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'promptgen_app') THEN
    CREATE ROLE promptgen_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO promptgen_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, companies, source_connections, artifacts, evidence,
  evidence_relations, runs, run_jobs, trace_events TO promptgen_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO promptgen_app;

COMMIT;
