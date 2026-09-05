BEGIN;

CREATE TABLE evidence_embeddings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0 AND dimensions <= 16000),
  embedding vector NOT NULL,
  input_hash text NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, evidence_id, provider, model),
  FOREIGN KEY (tenant_id, evidence_id) REFERENCES evidence(tenant_id, id) ON DELETE CASCADE,
  CHECK (vector_dims(embedding) = dimensions)
);

-- Each embedding dimension/model needs its own partial expression index.
CREATE INDEX evidence_embeddings_nomic_hnsw ON evidence_embeddings
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WHERE provider = 'ollama' AND model = 'nomic-embed-text' AND dimensions = 768;
CREATE INDEX evidence_embeddings_lookup ON evidence_embeddings (tenant_id, evidence_id, provider, model);

ALTER TABLE evidence_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_evidence_embeddings ON evidence_embeddings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON evidence_embeddings TO promptgen_app;

COMMIT;
