import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
export interface SecretEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
// Main owns the encrypted file. Hosts receive only an explicitly granted reference.
export class CredentialVault {
  private entries: Record<string, { generation: number; encrypted: string }> =
    {};
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly encryption: SecretEncryption,
  ) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(
        await readFile(join(this.directory, "credentials.json"), "utf8"),
      );
      if (
        data.schema !== 1 ||
        !data.entries ||
        typeof data.entries !== "object"
      )
        throw new Error("凭据存储格式无效");
      this.entries = data.entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private check(reference: string) {
    if (!/^[a-z][a-z0-9.-]{1,100}$/.test(reference) || reference.includes(".."))
      throw new Error("凭据引用无效");
    if (!this.encryption.isEncryptionAvailable())
      throw new Error("系统加密存储不可用");
  }
  rotate(reference: string, secret: string, expectedGeneration: number) {
    const job = this.writes.then(async () => {
      this.check(reference);
      if (typeof secret !== "string" || !secret || secret.length > 16384)
        throw new Error("凭据内容无效");
      const current = this.entries[reference]?.generation ?? 0;
      if (current !== expectedGeneration)
        throw new Error("凭据已更改，请刷新后重试");
      const entries = {
        ...this.entries,
        [reference]: {
          generation: current + 1,
          encrypted: this.encryption.encryptString(secret).toString("base64"),
        },
      };
      const path = join(this.directory, "credentials.json");
      await writeFile(path + ".tmp", JSON.stringify({ schema: 1, entries }), {
        mode: 0o600,
      });
      await rename(path + ".tmp", path);
      this.entries = entries;
      return { reference, generation: current + 1 };
    });
    this.writes = job.catch(() => {});
    return job;
  }
  async resolve(reference: string, allowed: ReadonlySet<string>) {
    this.check(reference);
    if (!allowed.has(reference)) throw new Error("Credential scope denied");
    await this.writes;
    const entry = this.entries[reference];
    if (!entry) throw new Error("凭据尚未配置");
    return this.encryption.decryptString(
      Buffer.from(entry.encrypted, "base64"),
    );
  }
  generation(reference: string) {
    return this.entries[reference]?.generation ?? 0;
  }
}
