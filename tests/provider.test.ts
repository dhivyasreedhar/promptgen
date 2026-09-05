import { describe, expect, it } from "vitest";
import { normalizeAnthropicPayload } from "../src/model/provider.js";

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
