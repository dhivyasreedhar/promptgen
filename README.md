# Manicule Promptgen V2

An evidence-first daily pipeline for generating AI-agent tracking prompts. It ingests public and private company context, converts source artifacts into traceable evidence, retrieves context per evidence need, discovers supported buyer opportunities, and returns exactly ten discovery prompts or an explicit `insufficient_evidence` result.

## What is different

- Raw artifacts, evidence, retrieved packs, opportunities, candidates, and final prompts have separate contracts.
- Every evidence record preserves its source artifact and exact quote.
- Current and historical artifact versions are retained; only current, unexpired, authorized evidence is retrieved.
- Evidence carries ACL scopes, lifecycle state, validity windows, source authority, and source-specific freshness decay.
- Extraction failures remain retryable and are never cached as successful empty results.
- Private data is marked `derive-only` or `aggregate-only`; prompts are checked for verbatim leakage.
- Boundary prompts do not consume discovery slots.
- All candidate transformations must return through one validation function before selection.
- Demand and capability are separate evidence roles: customer pain cannot double as proof that a feature exists.
- A separate, batched critic pass verifies role-level entailment and removes irrelevant citations before selection.
- If diversity leaves fewer than ten, a targeted uncovered-opportunity backfill loop runs through the same validation gates.
- Every run produces `result.json`, `prompts.md`, and a candidate-level `trace.json`.
- UI-triggered runs use a persisted lease-based queue with recovery, retry, cancellation, and source-health state.

## Quick start

Requires Node.js 24 or later.

```bash
npm install
PROMPTGEN_FIXTURE_SCALE=1 npm run fixtures:generate
PROMPTGEN_PUBLIC_WEB=false PROMPTGEN_MODEL_PROVIDER=local npm run dev
npm test
npm run build
```

The local provider exists to exercise the pipeline without API credentials. It is deterministic and deliberately not represented as production-equivalent generation quality.

## Model providers

Anthropic is preferred automatically when both providers are configured:

```bash
export ANTHROPIC_API_KEY=...
export ANTHROPIC_MODEL=claude-sonnet-5
export PROMPTGEN_MODEL_TIMEOUT_MS=300000
npm run dev
```

OpenAI is also supported:

```bash
export OPENAI_API_KEY=...
export OPENAI_MODEL=gpt-5-mini
export PROMPTGEN_MODEL_PROVIDER=openai
npm run dev
```

Set `PROMPTGEN_MODEL_PROVIDER` to `auto`, `anthropic`, `openai`, or `local`. The exact provider and model are recorded in every result and trace.

## Commands

```bash
npx tsx src/cli.ts run greptile --fixtures
npx tsx src/cli.ts run-all --fixtures
npx tsx src/cli.ts eval
npm run eval:prepare
npm run eval:human
npm run eval:annotate -- retrieval reviewer-a --limit=25
npm run eval:annotate -- prompts reviewer-a --limit=25
npm run eval:gate
npm run eval:judge
npm run eval:judge:report
npx tsx src/cli.ts scheduler --fixtures
npm run serve
```

The scheduler uses `PROMPTGEN_DAILY_AT` and `PROMPTGEN_TIMEZONE`, acquires and renews a tenant-scoped PostgreSQL lease when hosted metadata is configured, and skips companies with a successful hosted run in the preceding 20 hours. Failed runs remain eligible for retry. Without PostgreSQL it falls back to the local SQLite lease.

`npm run serve` opens a loopback-only domain discovery UI at `http://127.0.0.1:4317`. A user can enter a configured or public domain, open recorded-company shortcuts, run a single-flight analysis, and inspect each prompt's provenance and source. Unknown domains use only their public website: valid B2B products can produce conservative `inferred-opportunity` prompts from current public capability evidence, while inaccessible or indeterminate domains return `insufficient_evidence`. Raw derive-only private quotes are not exposed by the UI. The customer-facing tracking set is capped at ten total prompts; pinned benchmarks take precedence and discovery fills the remaining slots. The HTTP surface intentionally cannot bind to a public interface.

For a production host, run the one-shot command from the platform scheduler instead of keeping the process loop alive:

```cron
0 2 * * * cd /srv/promptgen && node dist/src/cli.js run-all
```

## Initial sources

Public connectors:

- Website and sitemap pages, origin-pinned across redirects.
- Recent public GitHub issues and pull requests.

Private fixture connectors:

- Google Search Console
- Slack
- Intercom
- Linear
- CRM
- sales calls
- Mintlify analytics

By default, the fixture generator creates 20,300 artifacts per company—81,200 total—with source-specific formats, a year of timestamps, repeated evidence, lifecycle ambiguity, and approximately 65% operational noise. Set `PROMPTGEN_FIXTURE_SCALE=1` for a 4,060-record-per-company development corpus. The generated topic coverage check under `fixtures/gold/` is intentionally reported as fixture consistency, not independent retrieval quality.

`npm run eval` reports three deliberately separate layers. Fixture coverage checks generator consistency. The five-case hand-authored corpus in `fixtures/benchmark/retrieval.json` is an adversarial safety regression for roadmap-versus-shipped evidence, expired claims, ACL restrictions, `never-expose`, noise, and vocabulary expansion. It is not presented as evidence of production retrieval quality. The human-evaluation report reads a 150-case retrieval queue and a 200-prompt grading queue under `eval/annotations`; it remains failed until actual reviewers meet the documented coverage and quality thresholds.

Run `npm run eval:prepare` after representative company runs to refresh the queues while preserving existing judgments by stable case ID. Reviewers use `npm run eval:annotate -- retrieval <reviewer-id>` and `npm run eval:annotate -- prompts <reviewer-id>`. `npm run eval:human` reports progress; `npm run eval:gate` is the non-zero release gate. The full labeling, overlap, and adjudication rules are in `eval/PROTOCOL.md`. Generated, fixture-derived, or model judgments are never counted as human labels.

`npm run eval:judge` runs an independent OpenAI judge twice with reversed evidence order and checkpointed retries. Machine results remain separate from human annotations. `npm run eval:rerank` replays the current ranker against the frozen candidate pools without regenerating easier cases or calling a model. Reports distinguish record recall from duplicate-collapsed claim recall, and split pipeline-accepted from pipeline-rejected candidates; neither is presented as human quality evidence. An LLM cannot prove that relevant evidence absent from its candidate pool does not exist.

Real private connectors implement the same `Connector` interface and must emit `SourceArtifact` values with genuine `private` visibility. Fixture provenance is validated and cannot be mistaken for connected customer data.

## Storage

SQLite through the stable `better-sqlite3` driver remains the executable local/test adapter. It stores immutable artifact versions, current-version pointers, evidence, FTS5 indexes, source health, durable jobs, run state, leases, model-call cache entries, and trace events. WAL mode, bounded `BEGIN IMMEDIATE` write batches, renewable leases, cancellation propagation, and atomic result-file replacement make one-host operation durable.

## Hosted Postgres metadata

The hosted context contract is in `infra/postgres/001_initial.sql`, with a local pgvector service in `compose.postgres.yml`. It includes tenant-scoped companies, encrypted-credential slots, connector cursors and health, object-store keys for raw artifacts, version/tombstone state, evidence ACLs and lifecycle, PostgreSQL full-text search, pgvector indexes, retryable/cancellable jobs, traces, prompt lifecycle, feedback, observations, and row-level security.

```bash
npm run postgres:migrate
npm run postgres:health
npm run postgres:search -- greptile "large monorepo code review"
npm run postgres:embed -- greptile 500
```

Semantic retrieval uses the open-source `nomic-embed-text` model through local Ollama by default. Install Ollama, run `ollama pull nomic-embed-text`, and keep its loopback service available. Documents and queries use the model's distinct retrieval prefixes. Customer context is embedded locally; Claude remains responsible for prompt generation, critique, and evidence-entailment review. Set `PROMPTGEN_EMBEDDING_PROVIDER=disabled` for lexical-only operation.

When `DATABASE_URL` is configured, every pipeline run synchronously records its tenant-scoped company, run result, provider, connector health/cursors, and complete trace in Postgres. UI jobs use atomic `FOR UPDATE SKIP LOCKED` claims, renewable leases, cancellation, bounded exponential retry, and one-active-job-per-company enforcement. Daily scheduler locks are also shared in PostgreSQL. A configured metadata write is part of run completion rather than a fire-and-forget side effect. Stable local identifiers are mapped to deterministic UUIDs for the hosted schema.

For Supabase, use the session-pooler URL when the runtime has no IPv6 route. `PGHOST`, `PGUSER`, `PGPORT`, `PGDATABASE`, and optionally `PGPASSWORD` override the corresponding URL components without logging the resolved secret. Set a distinct `PROMPTGEN_TENANT_ID` for each isolated customer tenant.

The checked-in migration runner records SHA-256 checksums and rejects edits to already-applied migrations. `postgres:health` verifies the server, pgvector extension, and forced-RLS coverage without returning credentials. Hosted context sync has been load-tested with the full 20,300-artifact/16,403-evidence Greptile fixture. Runtime retrieval now uses reciprocal-rank fusion between hosted search and the local recall guardrail. Hybrid search applies current-version, tombstone, ACL, safe-use, lifecycle, and validity filters before full-text, trigram, confidence, authority, freshness, and optional vector scoring. Exact duplicate and historical supersession relations are refreshed when context changes; ambiguous contradictions are left for review rather than inferred from fragile negation matching.

Each daily run embeds up to `PROMPTGEN_EMBEDDING_RUN_LIMIT` newly extracted records (500 by default). Historical backfills are also explicit, capped, and resumable so first-run prompt generation is not blocked by a large corpus. `postgres:embed` uses 768-dimensional local `nomic-embed-text` vectors by default and accepts at most 5,000 records per invocation. Embeddings live in a tenant-scoped table keyed by provider and model, with their input hash and dimension recorded; replacing the model does not mutate evidence or mix incompatible vector spaces. Runtime embedding failure is traced and degrades to hosted lexical retrieval plus the local recall guardrail rather than failing the customer run.

Set `PROMPTGEN_OBJECT_ENCRYPTION_KEY` to a base64-encoded 32-byte key to dual-write raw artifact bodies to the object-store abstraction. The local implementation uses AES-256-GCM with per-object nonces, authenticated tenant object keys, mode-0600 atomic writes, and no plaintext files. The same interface is the boundary for a future S3 or Supabase Storage implementation.

Successful runs also maintain a tenant-scoped prompt registry with stable keys, first/last-seen timestamps, active state, evidence history and scores. Every run records added/retained/removed prompt diffs. The loopback UI records human approvals/rejections, while `/api/prompts/:company/:prompt/observations` accepts downstream agent mention, citation and competitor outcomes. Rejections suppress the same stable prompt on later runs; approvals and repeated brand-losing observations get a bounded selection preference. Cross-origin mutations are rejected.

Every prompt is labeled `observed-question`, `adapted-from-evidence`, or `inferred-opportunity` and carries audience, use case, constraint, and decision-stage coverage. The UI exposes a redacted customer excerpt or public quote, source locator/link, buyer-intent class, and the exact privacy rules applied. Approvals pin immutable benchmark prompts; daily discovery prompts remain a separate evolving set. Structured rejection reasons can create company-wide audience, use-case, or semantic rules that are applied before selection on subsequent runs.

Private model egress is fail-closed. `never-expose` evidence is omitted, aggregate-only evidence becomes an aggregate description, and derive-only free text becomes a taxonomy summary containing no original sentence, names, identifiers, project names, or metrics. The trace stores input/output hashes, policy, safe preview, and transformation rule names without duplicating raw private text. Local embeddings and lexical retrieval may use authorized context, but external prompt models receive only this transformed representation.

Application roles must not own these tables and every transaction must set `app.tenant_id`; row-level security is a defense-in-depth boundary, not a replacement for authorization checks. Migration 003 creates a restricted `promptgen_app` role, and the metadata adapter drops into that role after setting the tenant inside every transaction. This prevents the configured owner connection from bypassing RLS. A deployed service should ultimately connect with a dedicated login role rather than the administrative `postgres` account. PostgreSQL now stores and ranks the hosted evidence catalog, while SQLite retains raw local bodies, exact quotes, the local recall guardrail, and model cache. Although jobs and leases are shared, workers must remain on a shared filesystem or a single host until a cloud object-store implementation is configured.

## Result contract

- `complete`: exactly ten validated discovery prompts.
- `insufficient_evidence`: fewer than ten, with explicit missing evidence and recommended sources.
- `failed`: infrastructure or provider failure; never treated as a completed daily run.

Boundary prompts are always returned separately.

## Quality, lifecycle, and operations

The safety regression reports recall at 3 and 12, reciprocal rank, precision, forbidden-hit rate, ACL/secret leakage, and stale-truth leakage over its five deterministic cases. Production-quality claims come only from the separate human evaluation: pooled retrieval judgments measure recall@3, recall@12, precision@12, forbidden hits, and reviewer agreement; prompt grades measure acceptance, buyer intent, recommendation likelihood, evidence entailment, distinctness, naturalness, and reviewer agreement. Context packs additionally reconcile near-duplicate capability evidence and contradictory current claims. A clear authority/freshness winner is retained with a trace decision; comparable contradictions are withheld rather than guessed.

Prompt continuity is keyed by the critic's semantic opportunity rather than exact wording. Human rejections suppress equivalent rewrites, approvals and brand-losing prompts receive a bounded preference, and every completed run records added, retained, and removed lifecycle events plus churn rate. The UI shows retention and churn alongside the prompt set.

Buying-intent classification rejects support, implementation, retention, and operational questions even when adjacent product evidence exists. Each draft also triggers a candidate-specific hybrid retrieval pass before deterministic validation and model critique. Unresolved contradictions are attached to that retrieval trace rather than treated as capability truth. Selection maximizes coverage novelty and permits a second prompt from one opportunity only when its archetype and semantic key are both distinct.

Operational endpoints are `GET /healthz`, `GET /readyz`, and Prometheus-compatible `GET /metrics`. Run and HTTP counters/durations are emitted without tenant content. Failures are classified as transient, authentication, configuration, validation, cancellation, or unknown; only retryable failures consume another queue attempt. Retrieval and embedding degradation remains explicit in the run trace. Run `npm run backup:verify` to create a SQLite online backup, open the restored copy, run its integrity check, compare critical table counts, and delete the temporary copy. PostgreSQL and object-store backup retention remains the responsibility of the selected managed providers and must be exercised in deployment runbooks.

## Current production boundary

Hosted context and operational metadata are connected and tested against PostgreSQL 17 with pgvector, forced tenant RLS, checksum migrations, distributed jobs/leases, context catalog sync, hybrid retrieval, evidence relations, prompt lifecycle, feedback and trace persistence. Local open-source embeddings require no additional API credential. The remaining external dependencies are a cloud object-store credential, real connector OAuth/data, a dedicated login role, and a second model/provider if cross-provider judging is required.
