# Human evaluation protocol

The five-case adversarial benchmark is a deterministic safety regression. It is not evidence of production retrieval or prompt quality. This protocol creates the separate human evidence required for those claims.

## Corpus

- `annotations/retrieval.json`: 150 query-to-evidence cases. Each query has a pooled set of up to 50 candidate evidence records and preserves the actual top-12 ranking under evaluation.
- `annotations/prompts.json`: 200 generated candidates sampled evenly across completed company runs. Accepted and rejected model candidates are both represented.
- Annotation files store stable evidence identifiers and judgments, not raw private source bodies. Reviewers must use an authorized local context snapshot to inspect the referenced evidence.

Regenerate queues with `npm run eval:prepare`. Existing judgments are preserved when case identifiers remain stable.

## Retrieval labels

For every query, inspect the complete candidate pool—not only the top 12—and label:

- **Relevant:** directly helps answer the evidence need.
- **Forbidden:** relevant or tempting context that must not be returned because of access, lifecycle, validity, or `never-expose` policy.
- Unselected evidence is treated as irrelevant.
- Record any known relevant evidence outside the candidate pool as a missing evidence ID. These misses remain in the recall denominator. Because exhaustive relevance judgment over a large corpus is impractical, reported recall is pooled recall and should be interpreted with that limitation.

Run:

```bash
npm run eval:annotate -- retrieval reviewer-a --limit=25
```

At least 100 of the 150 cases must have a human judgment. Twenty percent of reviewed cases should be independently labeled by a second reviewer. Disagreements should receive a `resolution` judgment from an adjudicator before a production claim is made.

## Prompt grades

Grade every prompt from 1–5 on:

1. Buyer intent
2. Likelihood of eliciting a product or vendor recommendation
3. Evidence entailment
4. Distinctness from other tracked opportunities
5. Naturalness as a real buyer question

Also record an explicit accept/reject decision. Run:

```bash
npm run eval:annotate -- prompts reviewer-a --limit=25
```

All 200 prompts must be graded. At least 20% should be independently graded by a second reviewer, with disagreements adjudicated.

## Release gate

`npm run eval:gate` exits non-zero unless all of these are true:

- At least 100 retrieval cases reviewed
- All 200 prompts graded
- Recall@12 ≥ 0.85
- Precision@12 ≥ 0.60
- Forbidden-hit rate = 0
- Prompt acceptance rate ≥ 0.80
- Mean recommendation likelihood ≥ 4.0
- Mean evidence entailment ≥ 4.0

`npm run eval:human` always prints the current report without enforcing the exit code. Never describe pending, model-generated, or fixture-derived labels as human judgments.
