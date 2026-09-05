import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingInputHash, OllamaEmbeddingProvider } from "../src/retrieval/embeddings.js";

describe("OllamaEmbeddingProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the correct retrieval prefixes and validates dimensions", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input).toEqual(["search_query: buyer question"]);
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaEmbeddingProvider("test-model", 3, "http://127.0.0.1:11434");
    await expect(provider.embedQueries(["buyer question"])).resolves.toEqual([[0.1, 0.2, 0.3]]);
  });

  it("rejects malformed vectors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 })));
    const provider = new OllamaEmbeddingProvider("test-model", 3);
    await expect(provider.embedDocuments(["context"])).rejects.toThrow("expected 3");
  });

  it("supports a local OpenAI-compatible llama.cpp endpoint", async () => {
    const fetchMock = vi.fn(async (url: URL) => url.pathname === "/api/embed"
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.2, 0.3, 0.4] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OllamaEmbeddingProvider("test-model", 3, "http://127.0.0.1:11435");
    await expect(provider.embedDocuments(["context"])).resolves.toEqual([[0.2, 0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hashes the exact embedded input deterministically", () => {
    expect(embeddingInputHash("claim")).toBe(embeddingInputHash("claim"));
    expect(embeddingInputHash("claim")).not.toBe(embeddingInputHash("Claim"));
  });
});
