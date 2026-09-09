import { Metadata, MetadataKind } from "@tufjs/models";
import { DefaultFetcher } from "tuf-js/dist/fetcher";
import { DownloadHTTPError } from "tuf-js/dist/error";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
export class RecordingFetcher extends DefaultFetcher {
  constructor(
    readonly directory: string,
    readonly transport?: typeof globalThis.fetch,
  ) {
    super({ timeout: 15000, retry: 1 });
  }
  override async fetch(
    url: string,
  ): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    if (!this.transport) return super.fetch(url);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.transport(url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new DownloadHTTPError(
            "Failed to download update metadata or target",
            response.status,
          );
        }
        return response.body;
      } catch (error) {
        if (
          attempt >= 1 ||
          (error instanceof DownloadHTTPError && error.statusCode < 500)
        )
          throw error;
      }
    }
  }
  override async downloadBytes(url: string, maxLength: number) {
    const bytes = await super.downloadBytes(url, maxLength);
    const match = new URL(url).pathname.match(/\/(\d+)\.root\.json$/);
    if (match) {
      await mkdir(this.directory, { recursive: true });
      await writeFile(join(this.directory, match[1] + ".json"), bytes, {
        mode: 0o600,
      });
    }
    return bytes;
  }
}
export interface Receipt {
  rootVersion: number;
  targets: unknown;
  manifestTarget: string;
  manifestBytes: string;
}
export async function trustedRoot(
  rootPath: string,
  chainDirectory: string,
  version: number,
) {
  let root = Metadata.fromJSON(
    MetadataKind.Root,
    JSON.parse(await readFile(rootPath, "utf8")),
  );
  if (version < root.signed.version || version - root.signed.version > 1000)
    throw new Error("无效根版本");
  while (root.signed.version < version) {
    const next = Metadata.fromJSON(
      MetadataKind.Root,
      JSON.parse(
        await readFile(
          join(chainDirectory, String(root.signed.version + 1) + ".json"),
          "utf8",
        ),
      ),
    );
    if (next.signed.version !== root.signed.version + 1)
      throw new Error("根版本不连续");
    root.verifyDelegate("root", next);
    next.verifyDelegate("root", next);
    root = next;
  }
  return root;
}
export async function verifyReceipt(
  receipt: Receipt,
  rootPath: string,
  chainDirectory: string,
  activation = false,
) {
  const root = await trustedRoot(rootPath, chainDirectory, receipt.rootVersion);
  const targets = Metadata.fromJSON(
    MetadataKind.Targets,
    receipt.targets as any,
  );
  root.verifyDelegate("targets", targets);
  if (activation && (root.signed.isExpired() || targets.signed.isExpired()))
    throw new Error("签名元数据过期，请重新检查更新");
  const target = targets.signed.targets[receipt.manifestTarget];
  if (!target) throw new Error("版本清单不在已签名目录内");
  const bytes = Buffer.from(receipt.manifestBytes, "base64");
  await target.verify(Readable.from(bytes));
  return JSON.parse(bytes.toString("utf8"));
}
