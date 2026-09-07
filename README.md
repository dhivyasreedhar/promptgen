# Manicule Promptgen

An evidence-first pipeline that turns a company domain and available customer context into ten buyer questions worth tracking across AI agents.

- Live demo: <https://manicule-promptgen-demo.onrender.com>
- Runtime: TypeScript on Node.js 24
- Generation: Anthropic or OpenAI, with deterministic local fallback
- Retrieval: PostgreSQL full-text/trigram search plus pgvector
- Hosted deployment: Render web service, two background workers, Render cron, and Supabase Postgres

## What the demo contains

Public collection is real. The pipeline crawls a submitted company's website and documentation and can collect recent public GitHub issues and pull requests for configured organizations.

Private context is simulated. These four recorded demo companies have source-shaped synthetic data for Google Search Console, Slack, Intercom, Linear, CRM, sales calls, and Mintlify analytics:

- Greptile (`greptile.com`)
- Rootly (`rootly.com`)
- Reducto (`reducto.ai`)
- Supermemory (`supermemory.ai`)

Every other submitted domain is public-only. The fixtures exercise noisy data, duplication, lifecycle changes, permissions, conflicting claims, and private-data transformations; they are never represented as real customer data.

## How a run works

1. Validate and normalize the domain.
2. Return a complete published result immediately when it is less than 20 hours old, unless the user explicitly selects **Run again**.
3. Enqueue a durable analysis job in Postgres.
4. Collect public sources and, for the four demo companies, synthetic connected context.
5. Normalize each source item into a versioned `SourceArtifact`.
6. Extract smaller `EvidenceRecord` claims for demand, capability, constraints, comparisons, buyer language, and product changes.
7. Apply tenant, ACL, lifecycle, freshness, and external-use policy before ranking.
8. Discover buyer situations and run hybrid semantic, lexical, and structured retrieval.
9. Generate candidate prompts, then retrieve again for each candidate's exact claims.
10. Critique, repair, revalidate, deduplicate, and select a diverse final set.
11. Publish exactly ten customer-facing prompt slots or an explicit `insufficient_evidence` result.

Every published prompt keeps provenance and supporting evidence. Demand evidence proves that a buyer situation matters; capability evidence separately proves that the company could credibly be recommended for it.

## Output contract

- `complete`: exactly ten validated customer-facing prompts. Pinned benchmark prompts take precedence; discovery prompts fill the remaining slots.
- `insufficient_evidence`: fewer than ten supported prompts, with the shortfall made explicit. The pipeline does not fabricate a complete set.
- `failed`: an infrastructure, configuration, or provider failure. A failed run never replaces the last good published set.

Prompts are labeled `observed-question`, `adapted-from-evidence`, or `inferred-opportunity`. Boundary prompts are reported separately and never consume the ten customer-facing slots.

## Local setup

Requirements:

- Node.js 24 or later
- An Anthropic or OpenAI key for model-backed generation
- Optional Postgres with pgvector for the hosted retrieval path

```bash
npm ci
cp .env.example .env
PROMPTGEN_FIXTURE_SCALE=1 npm run fixtures:generate
npm run serve
```

Open <http://127.0.0.1:4317>.

The deterministic local provider is useful for exercising the pipeline without credentials, but it is not production-equivalent generation:

```bash
PROMPTGEN_PUBLIC_WEB=false \
PROMPTGEN_MODEL_PROVIDER=local \
npm run serve
```

## Model configuration

`PROMPTGEN_MODEL_PROVIDER` accepts `auto`, `anthropic`, `openai`, or `local`. With `auto`, Anthropic is preferred when configured and OpenAI is used as failover. The exact provider and model are recorded in every result and trace.

```bash
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
OPENAI_JUDGE_MODEL=gpt-4.1-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
PROMPTGEN_EMBEDDING_PROVIDER=openai
```

When both API keys are present, Anthropic generates candidates and the OpenAI judge independently checks prompt quality and grounding. OpenAI is also the hosted embedding provider. Local development can instead use `nomic-embed-text` through Ollama or set `PROMPTGEN_EMBEDDING_PROVIDER=disabled` for lexical-only retrieval.

## Common commands

```bash
# UI and company runs
npm run serve
npx tsx src/cli.ts run greptile --fixtures
npx tsx src/cli.ts run-all --fixtures

# Verification
npm run check
npm test
npm run build
npm run eval:release-gate

# Evaluation maintenance
npm run eval
npm run eval:prepare
npm run eval:human
npm run eval:judge
npm run eval:judge:report
npm run eval:rerank

# Hosted Postgres
npm run postgres:migrate
npm run postgres:health
npm run postgres:search -- greptile "large monorepo code review"
npm run postgres:embed -- greptile 500

# Operations
npm run canary
npm run canary:reassess
npm run backup:verify
```

The full human-labeling protocol is in [`eval/PROTOCOL.md`](eval/PROTOCOL.md).

## Hosted architecture

When `DATABASE_URL` is configured, Postgres is the canonical hosted data plane. It stores tenant-scoped artifacts, evidence and exact quotes, ACLs, source health, embeddings, model cache entries, jobs, runs, traces, prompt lifecycle, and canary reports.

Full source bodies are encrypted by the application with AES-256-GCM before being written to `shared_objects`. Hosted correctness does not depend on a Render disk. SQLite remains a local/test adapter and disposable per-worker scratch store.

The web process only validates requests, enqueues jobs, and reads shared results. Workers claim jobs using `FOR UPDATE SKIP LOCKED`, renew leases, support cancellation and bounded retry, and enforce one active job per company. Public-only jobs receive queue priority over fixture-heavy jobs.

`render.yaml` defines:

- One public web service with inline work disabled
- Two stateless background worker instances
- One daily canary cron at `10:00 UTC`
- A shared environment group for non-secret configuration

After the first Blueprint sync, add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `DATABASE_URL` to the `promptgen-shared` environment group. Render generates `PROMPTGEN_OBJECT_ENCRYPTION_KEY`. The public demo intentionally has no application authentication; authentication and real tenant identity propagation are required before connecting customer data.

Use Supabase's IPv4-compatible session-pooler URL when the runtime has no IPv6 route. Migrations are checksum-protected and must never be edited after application.

## Retrieval and privacy guarantees

- Eligibility is checked before relevance: wrong-tenant, unauthorized, expired, deprecated, planned, and `never-expose` records cannot win ranking.
- Hosted retrieval fuses Postgres full-text search, trigram matching, and 768-dimensional pgvector embeddings using reciprocal-rank fusion.
- Candidate-specific retrieval checks the exact audience, capability, integration, constraint, performance, pricing, purchase-channel, and modality claims before acceptance.
- Repaired and backfilled prompts return through the complete validator.
- Near-duplicate evidence is collapsed while unresolved contradictions remain visible in the trace.
- `derive-only` context becomes de-identified taxonomy; `aggregate-only` context becomes a summary; `never-expose` context is omitted from external model calls.
- Model transformations record policy and input/output hashes without copying raw private content into the trace.

## Evaluation

The repository keeps machine and human evaluation separate:

- 109 unit and integration tests across 26 files cover contracts, policy, extraction, ranking, validation, selection, scheduling, storage, and API behavior.
- Five hand-authored adversarial retrieval cases guard against stale claims, planned capabilities, ACL failures, `never-expose` leakage, and vocabulary mismatch. They are regression tests, not proof of retrieval quality.
- A frozen 150-case retrieval corpus is judged twice by an independent OpenAI model and reranked without regenerating easier cases.
- A frozen 200-prompt corpus measures buyer intent, recommendation likelihood, grounding, distinctness, and naturalness.
- The release gate blocks material regression from `eval/machine-baseline.json` and requires zero forbidden retrievals.
- Human evaluation is not complete: 0/150 retrieval cases and 1/200 prompt cases currently have human review. Machine scores are never presented as human ground truth.

Current frozen machine baseline:

- Unique-claim recall@12: 65.1%
- Precision@12: 47.2%
- Forbidden retrieval rate: 0%
- Accepted-prompt judge acceptance: 77.8%
- Rejected-prompt judge rejection: 66.4%
- Recommendation likelihood: 4.13/5
- Evidence entailment: 3.92/5

## Operational behavior

- `GET /healthz`: process liveness
- `GET /readyz`: dependency readiness
- `GET /metrics`: Prometheus-compatible counters and durations without tenant content
- `GET /api/quality`: latest canary report without private evidence

Failures are classified as transient, authentication, configuration, validation, cancellation, or unknown. Only retryable failures consume another queue attempt. Embedding degradation falls back to hosted lexical retrieval plus the local recall guardrail and remains visible in the trace.

The daily canary runs the four configured fixture companies, allows one bounded expanded-recall retry, grades staged prompt sets, and preserves the previous published set when the new candidate fails. The UI reuses complete results under 20 hours old; explicit refresh bypasses that result-level cache while artifact, extraction, embedding, and model caches still avoid unchanged downstream work.

## Production boundary

Implemented today:

- Public web and configured GitHub collection
- Versioned evidence with lifecycle, freshness, ACLs, conflict handling, and traceable citations
- Shared Postgres data plane with pgvector, encrypted source bodies, model cache, durable jobs, multiple workers, and daily canaries
- Candidate-specific retrieval, independent critique, deterministic validation, exact slot selection, and prompt lifecycle tracking

Still required before real customer deployment:

- At least one real OAuth connector with cursors, pagination, rate limits, deletion handling, and permission tests
- Authentication and a dedicated non-owner database login role
- Cross-tenant isolation and security testing
- Human adjudication of the retrieval and prompt corpora
- Connector-level incremental fetching and realistic load testing
- External object storage if source volume outgrows encrypted Postgres objects
