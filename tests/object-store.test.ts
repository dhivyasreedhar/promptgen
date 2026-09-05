import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedFileObjectStore } from "../src/store/object-store.js";

describe("EncryptedFileObjectStore", () => {
  it("round-trips authenticated ciphertext without writing plaintext", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "promptgen-objects-"));
    try {
      const store = new EncryptedFileObjectStore(root, randomBytes(32).toString("base64"));
      const secret = "private Slack customer context";
      await store.put("tenant/company/artifact", secret);
      expect(await store.get("tenant/company/artifact")).toBe(secret);
      const files = await import("node:fs/promises").then(fs => fs.readdir(root, { recursive: true }));
      const object = files.find(file => String(file).endsWith(".pgo"));
      expect(object).toBeTruthy();
      expect((await readFile(path.join(root, String(object)))).includes(Buffer.from(secret))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
