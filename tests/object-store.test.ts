import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedFileObjectStore, PostgresObjectStore } from "../src/store/object-store.js";
import type { PostgresMetadataStore } from "../src/store/postgres-metadata.js";

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

describe("PostgresObjectStore", () => {
  it("round-trips encrypted shared payloads without sending plaintext to storage", async () => {
    const rows = new Map<string, Buffer>();
    const backend = {
      putSharedObject: async (key: string, payload: Buffer) => { rows.set(key, payload); },
      getSharedObject: async (key: string) => rows.get(key) ?? Promise.reject(new Error("missing")),
      deleteSharedObject: async (key: string) => { rows.delete(key); },
    } as unknown as PostgresMetadataStore;
    const store = new PostgresObjectStore(backend, randomBytes(32).toString("base64"));
    const secret = "private Slack customer context";
    await store.put("tenant/company/artifact", secret);
    expect(rows.get("tenant/company/artifact")?.includes(Buffer.from(secret))).toBe(false);
    expect(await store.get("tenant/company/artifact")).toBe(secret);
    await store.delete("tenant/company/artifact");
    expect(rows.size).toBe(0);
  });
});
