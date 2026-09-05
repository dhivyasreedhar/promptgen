import { createHash } from "node:crypto";
import OpenAI from "openai";

export interface StoredEmbedding {
  provider: string;
  model: string;
  dimensions: number;
  values: number[];
}

export interface EmbeddingProvider {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  embedQueries(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

interface OllamaEmbedResponse { embeddings?: unknown }
interface CompatibleEmbedResponse { data?: Array<{ index?: number; embedding?: unknown }> }

/** Local embeddings through Ollama. No customer context leaves the machine. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "ollama";

  constructor(
    readonly model = "nomic-embed-text",
    readonly dimensions = 768,
    private readonly baseUrl = "http://127.0.0.1:11434",
    private readonly timeoutMs = 120_000,
  ) {}

  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embed(texts.map(text => `search_document: ${text}`), signal);
  }

  embedQueries(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.embed(texts.map(text => `search_query: ${text}`), signal);
  }

  private async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    if (input.length === 0) return [];
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(new URL("/api/embed", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input, truncate: true, keep_alive: "10m" }),
        signal: combined,
      });
    } catch (error) {
      throw new Error(`Local embedding service unavailable at ${this.baseUrl}: ${errorMessage(error)}`);
    }
    let rawEmbeddings: unknown;
    if (response.status === 404) {
      const compatible = await fetch(new URL("/v1/embeddings", this.baseUrl), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input }), signal: combined,
      });
      if (!compatible.ok) throw new Error(`Local embedding service returned ${compatible.status}: ${(await compatible.text()).slice(0, 500)}`);
      const payload = await compatible.json() as CompatibleEmbedResponse;
      rawEmbeddings = payload.data?.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(item => item.embedding);
    } else {
      if (!response.ok) throw new Error(`Local embedding service returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
      rawEmbeddings = (await response.json() as OllamaEmbedResponse).embeddings;
    }
    if (!Array.isArray(rawEmbeddings) || rawEmbeddings.length !== input.length) {
      throw new Error("Local embedding service returned an incomplete batch");
    }
    return rawEmbeddings.map((value, index) => {
      if (!Array.isArray(value) || value.length !== this.dimensions || value.some(number => typeof number !== "number" || !Number.isFinite(number))) {
        throw new Error(`Embedding ${index} has invalid values or dimensions; expected ${this.dimensions}`);
      }
      return value as number[];
    });
  }
}

/** Hosted embeddings through OpenAI. The 768-dimensional projection matches
 * the installed pgvector index while retaining the small model's semantics. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai";
  constructor(private readonly apiKey: string, readonly model = "text-embedding-3-small", readonly dimensions = 768, private readonly timeoutMs = 30_000) {}
  private client(): OpenAI { return new OpenAI({ apiKey: this.apiKey, timeout: this.timeoutMs, maxRetries: 2 }); }
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> { return this.embed(texts, signal); }
  embedQueries(texts: string[], signal?: AbortSignal): Promise<number[][]> { return this.embed(texts, signal); }
  private async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client().embeddings.create({ model: this.model, input: texts, dimensions: this.dimensions }, { signal });
    const values = response.data.slice().sort((a, b) => a.index - b.index).map(item => item.embedding);
    if (values.length !== texts.length || values.some(value => value.length !== this.dimensions || value.some(number => !Number.isFinite(number)))) throw new Error(`OpenAI returned invalid embedding dimensions; expected ${this.dimensions}`);
    return values;
  }
}

export function embeddingInputHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
