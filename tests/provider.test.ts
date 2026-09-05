import { describe, expect, it, vi } from "vitest";
import { FailoverPromptModel, normalizeAnthropicPayload, type PromptModel } from "../src/model/provider.js";

describe("Anthropic payload normalization", () => {
  it("decodes nested stringified tool fields", () => {
    const reviews = [{ candidateId: "c1" }];
    const deeplyEncoded = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(reviews)))));
    expect(normalizeAnthropicPayload({ reviews: deeplyEncoded }, "reviews")).toEqual({ reviews });
  });

  it("unwraps nested objects and fenced JSON", () => {
    const reviews = [{ candidateId: "c1" }];
    expect(normalizeAnthropicPayload({ reviews: JSON.stringify({ reviews: `\`\`\`json\n${JSON.stringify(reviews)}\n\`\`\`` }) }, "reviews")).toEqual({ reviews });
  });

  it("leaves malformed payloads for schema validation to reject", () => {
    const malformed = { reviews: "not-json" };
    expect(normalizeAnthropicPayload(malformed, "reviews")).toBe(malformed);
  });

  it("extracts a serialized array from explanatory tool text", () => {
    const reviews = [{ candidateId: "c1" }];
    expect(normalizeAnthropicPayload({ reviews: `Completed reviews: ${JSON.stringify(reviews)}` }, "reviews")).toEqual({ reviews });
  });
});

describe("model provider failover", () => {
  it("uses the secondary provider when generation fails before producing prompts", async () => {
    const primary = { name: "anthropic:test", generate: vi.fn().mockRejectedValue(new Error("credit balance too low")) } as unknown as PromptModel;
    const fallbackPrompts = [{ id: "fallback-prompt" }];
    const fallback = { name: "openai:test", generate: vi.fn().mockResolvedValue(fallbackPrompts) } as unknown as PromptModel;
    const model = new FailoverPromptModel(primary, fallback);

    const result = await model.generate({} as never, [], new Map());

    expect(result).toBe(fallbackPrompts);
    expect(fallback.generate).toHaveBeenCalledOnce();
  });

  it("does not fail over a cancelled request", async () => {
    const primary = { name: "anthropic:test", generate: vi.fn().mockRejectedValue(new Error("cancelled")) } as unknown as PromptModel;
    const fallback = { name: "openai:test", generate: vi.fn() } as unknown as PromptModel;
    const controller = new AbortController(); controller.abort();
    const model = new FailoverPromptModel(primary, fallback);

    await expect(model.generate({} as never, [], new Map(), controller.signal)).rejects.toThrow("cancelled");
    expect(fallback.generate).not.toHaveBeenCalled();
  });
});
