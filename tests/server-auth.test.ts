import { describe, expect, it } from "vitest";
import { isAuthorizationValid, isExternalServingAllowed, shouldUseFreshResult, useFixturesForDomain } from "../src/server.js";
import type { RunResult } from "../src/types.js";

describe("hosted demo authentication", () => {
  it("accepts any Basic username only when the password matches", () => {
    expect(isAuthorizationValid(`Basic ${Buffer.from("manicule:a-strong-demo-password").toString("base64")}`, "a-strong-demo-password")).toBe(true);
    expect(isAuthorizationValid(`Basic ${Buffer.from("manicule:wrong-password").toString("base64")}`, "a-strong-demo-password")).toBe(false);
    expect(isAuthorizationValid(undefined, "a-strong-demo-password")).toBe(false);
  });

  it("requires an explicit choice before serving without authentication", () => {
    expect(isExternalServingAllowed("127.0.0.1", undefined, false)).toBe(true);
    expect(isExternalServingAllowed("0.0.0.0", undefined, false)).toBe(false);
    expect(isExternalServingAllowed("0.0.0.0", "a-strong-demo-password", false)).toBe(true);
    expect(isExternalServingAllowed("0.0.0.0", undefined, true)).toBe(true);
  });
});

describe("domain fixture routing", () => {
  it("uses fixtures only for explicitly configured demo companies", () => {
    expect(useFixturesForDomain(undefined)).toBe(false);
    expect(useFixturesForDomain({ id: "demo", name: "Demo", domain: "demo.test", category: "developer tool",
      githubOrganizations: [], enabledSources: ["web", "slack"] })).toBe(true);
  });
});

describe("existing domain result reuse", () => {
  const result = { status: "complete", completedAt: "2026-09-06T12:00:00.000Z",
    discoveryPrompts: Array.from({ length: 10 }, (_, index) => ({ id: `p-${index}`, semanticKey: `s-${index}` })),
    benchmarkPrompts: [] } as unknown as RunResult;

  it("returns today's complete ten-prompt result without enqueueing another run", () => {
    expect(shouldUseFreshResult(result, new Date("2026-09-07T07:59:59.000Z"))).toBe(true);
    expect(shouldUseFreshResult(result, new Date("2026-09-07T08:00:00.000Z"))).toBe(false);
  });

  it("does not reuse partial or failed prompt sets", () => {
    expect(shouldUseFreshResult({ ...result, discoveryPrompts: result.discoveryPrompts.slice(0, 9) })).toBe(false);
    expect(shouldUseFreshResult({ ...result, status: "failed" })).toBe(false);
  });
});
