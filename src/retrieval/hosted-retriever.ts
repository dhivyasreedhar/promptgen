import { DEFAULT_ACCESS } from "../context/policy.js";
import type { EvidenceDatabase } from "../store/database.js";
import type { PostgresMetadataStore } from "../store/postgres-metadata.js";
import type { AccessContext, EvidenceNeed, EvidencePack, RankedEvidence } from "../types.js";
import { EvidenceRetriever, rankCandidatePool } from "./retriever.js";
import type { EmbeddingProvider, StoredEmbedding } from "./embeddings.js";

export class HostedEvidenceRetriever {
  private embeddingUnavailable = false;
  private hostedUnavailable = false;
  constructor(private readonly hosted: PostgresMetadataStore, private readonly local: EvidenceDatabase,
    private readonly embeddings?: EmbeddingProvider,
    private readonly onEmbeddingStatus?: (status: { status: "used" | "degraded"; model: string; queries?: number; error?: string }) => void,
    private readonly onHostedError?: (error: string) => void) {}

  async retrieve(companyId: string, needs: EvidenceNeed[], perNeed = 12, access: AccessContext = DEFAULT_ACCESS): Promise<EvidencePack[]> {
    const localPacks = new EvidenceRetriever(this.local).retrieve(companyId, needs, perNeed * 3, access);
    const health = new Map(this.local.sourceHealth(companyId).map(item => [item.source, item]));
    const queryEmbeddings = await this.embedNeeds(needs);
    return mapConcurrent(needs, 6, async (need, index) => {
      let hits: Awaited<ReturnType<PostgresMetadataStore["searchEvidence"]>> = [];
      if (!this.hostedUnavailable) {
        try {
          hits = await this.hosted.searchEvidence({ companyKey: companyId, query: need.query, kinds: need.kinds,
            scopes: access.scopes, limit: Math.max(perNeed * 5, 30),
            ...(queryEmbeddings[index] ? { embedding: queryEmbeddings[index] } : {}) });
        } catch (error) {
          this.hostedUnavailable = true;
          this.onHostedError?.(error instanceof Error ? error.message : String(error));
        }
      }
      const sharedRecords = await this.hosted.evidenceByExternalIds(hits.map(hit => hit.evidenceId));
      const byId = new Map([...sharedRecords, ...this.local.evidenceByIds(hits.map(hit => hit.evidenceId))].map(record => [record.id, record]));
      const fused = new Map<string, RankedEvidence>();
      hits.forEach((hit, rank) => { const evidence = byId.get(hit.evidenceId); if (evidence) fused.set(evidence.id,
        { evidence, score: 1 / (60 + rank + 1), reasons: ["hosted-hybrid-rank", `hosted-score:${hit.score.toFixed(3)}`] }); });
      (localPacks[index]?.records ?? []).forEach((item, rank) => {
        const prior = fused.get(item.evidence.id); fused.set(item.evidence.id, { evidence: item.evidence,
          score: (prior?.score ?? 0) + 1 / (60 + rank + 1), reasons: [...(prior?.reasons ?? []), "local-recall-rank", ...item.reasons] });
      });
      const fusedOrder = [...fused.values()].sort((left, right) => right.score - left.score);
      const selected = rankCandidatePool(fusedOrder.map((item, rank) => ({ record: item.evidence, lexicalRank: rank + 1 })), need, perNeed, access, health);
      return { need, records: selected.records, missing: selected.records.length < 2, reconciliation: selected.reconciliation };
    });
  }

  private async embedNeeds(needs: EvidenceNeed[]): Promise<Array<StoredEmbedding | undefined>> {
    if (!this.embeddings || this.embeddingUnavailable || needs.length === 0) return needs.map(() => undefined);
    try {
      const vectors = await this.embeddings.embedQueries(needs.map(need => need.query));
      this.onEmbeddingStatus?.({ status: "used", model: this.embeddings.model, queries: vectors.length });
      return vectors.map(values => ({ provider: this.embeddings!.provider, model: this.embeddings!.model,
        dimensions: this.embeddings!.dimensions, values }));
    } catch (error) {
      // Retrieval remains available through hosted lexical search and the local recall guardrail.
      this.embeddingUnavailable = true;
      this.onEmbeddingStatus?.({ status: "degraded", model: this.embeddings.model,
        error: error instanceof Error ? error.message : String(error) });
      return needs.map(() => undefined);
    }
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!, index);
    }
  }));
  return results;
}
