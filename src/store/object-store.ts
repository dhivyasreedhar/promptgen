import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PostgresMetadataStore } from "./postgres-metadata.js";

export interface ObjectStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export class EncryptedFileObjectStore implements ObjectStore {
  private readonly key: Buffer;
  constructor(private readonly root: string, encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.length !== 32) throw new Error("PROMPTGEN_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  async put(key: string, value: string): Promise<void> {
    const target = this.pathFor(key); await mkdir(path.dirname(target), { recursive: true });
    const payload = encryptObject(key, value, this.key);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 }); await rename(temporary, target);
  }

  async get(key: string): Promise<string> {
    return decryptObject(key, await readFile(this.pathFor(key)), this.key);
  }

  async delete(key: string): Promise<void> { await unlink(this.pathFor(key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }

  private pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.root, digest.slice(0, 2), `${digest}.pgo`);
  }
}

/** Shared encrypted source-body store used by stateless horizontal workers. */
export class PostgresObjectStore implements ObjectStore {
  private readonly key: Buffer;
  constructor(private readonly store: PostgresMetadataStore, encodedKey: string) {
    this.key = decodeKey(encodedKey);
  }

  async put(key: string, value: string): Promise<void> {
    await this.store.putSharedObject(key, encryptObject(key, value, this.key), createHash("sha256").update(value).digest("hex"));
  }

  async get(key: string): Promise<string> {
    return decryptObject(key, await this.store.getSharedObject(key), this.key);
  }

  async delete(key: string): Promise<void> { await this.store.deleteSharedObject(key); }
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) throw new Error("PROMPTGEN_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function encryptObject(objectKey: string, value: string, key: Buffer): Buffer {
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(objectKey));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("PGO1"), nonce, cipher.getAuthTag(), encrypted]);
}

function decryptObject(objectKey: string, payload: Buffer, key: Buffer): string {
  if (payload.subarray(0, 4).toString() !== "PGO1" || payload.length < 32) throw new Error("Invalid encrypted object");
  const nonce = payload.subarray(4, 16), tag = payload.subarray(16, 32), encrypted = payload.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(Buffer.from(objectKey)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function artifactObjectKey(tenantId: string, companyId: string, artifactId: string): string {
  return `tenants/${tenantId}/companies/${companyId}/artifacts/${artifactId}`;
}
