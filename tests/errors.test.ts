import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/operations/errors.js";

describe("failure classification", () => {
  it("retries transient provider and network failures", () => {
    expect(classifyFailure(new Error("429 rate limit")).retryable).toBe(true);
    expect(classifyFailure(new Error("socket timeout")).class).toBe("transient");
  });
  it("does not retry authentication, configuration, or cancellation failures", () => {
    expect(classifyFailure(new Error("401 invalid API key")).retryable).toBe(false);
    expect(classifyFailure(new Error("DATABASE_URL is not configured")).retryable).toBe(false);
    expect(classifyFailure(new Error("Job cancellation requested")).retryable).toBe(false);
    expect(classifyFailure(new Error("violates foreign key constraint")).retryable).toBe(false);
  });
});
