import { describe, expect, it } from "vitest";
import { stableUuid } from "../src/util.js";

describe("stableUuid", () => {
  it("is deterministic, namespaced, and RFC 4122 shaped", () => {
    const first = stableUuid("company", "tenant-a", "greptile");
    expect(first).toBe(stableUuid("company", "tenant-a", "greptile"));
    expect(first).not.toBe(stableUuid("run", "tenant-a", "greptile"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
