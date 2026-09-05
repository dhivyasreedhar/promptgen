BEGIN;
CREATE INDEX evidence_claim_identity ON evidence(tenant_id,company_id,md5(lower(claim)));
CREATE INDEX evidence_relation_from ON evidence_relations(tenant_id,from_evidence_id,relation);
COMMIT;
