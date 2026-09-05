import { describe, expect, it } from "vitest";
import { isAuthorizationValid, isExternalServingAllowed, useFixturesForDomain } from "../src/server.js";

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
