import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(key));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const payload = Buffer.concat([Buffer.from("PGO1"), nonce, cipher.getAuthTag(), encrypted]);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 }); await rename(temporary, target);
  }

  async get(key: string): Promise<string> {
    const payload = await readFile(this.pathFor(key));
    if (payload.subarray(0, 4).toString() !== "PGO1" || payload.length < 32) throw new Error("Invalid encrypted object");
    const nonce = payload.subarray(4, 16), tag = payload.subarray(16, 32), encrypted = payload.subarray(32);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce); decipher.setAAD(Buffer.from(key)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }

  async delete(key: string): Promise<void> { await unlink(this.pathFor(key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }

  private pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(this.root, digest.slice(0, 2), `${digest}.pgo`);
  }
}

export function artifactObjectKey(tenantId: string, companyId: string, artifactId: string): string {
  return `tenants/${tenantId}/companies/${companyId}/artifacts/${artifactId}`;
}
