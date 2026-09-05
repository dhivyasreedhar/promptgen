BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX evidence_claim_trigram ON evidence USING gin (claim gin_trgm_ops);

COMMIT;
