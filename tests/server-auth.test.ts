import { describe, expect, it } from "vitest";
import { isAuthorizationValid } from "../src/server.js";

describe("hosted demo authentication", () => {
  it("accepts any Basic username only when the password matches", () => {
    expect(isAuthorizationValid(`Basic ${Buffer.from("manicule:a-strong-demo-password").toString("base64")}`, "a-strong-demo-password")).toBe(true);
    expect(isAuthorizationValid(`Basic ${Buffer.from("manicule:wrong-password").toString("base64")}`, "a-strong-demo-password")).toBe(false);
    expect(isAuthorizationValid(undefined, "a-strong-demo-password")).toBe(false);
  });
});
