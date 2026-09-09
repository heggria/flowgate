import { mkdir, readFile, rename, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { Updater } from "tuf-js";
import type { ReleaseSet } from "../../contracts/src/index";
import { validateRelease, verifyDirectory } from "./loader";
import {
  RecordingFetcher,
  trustedRoot,
  verifyReceipt,
  type Receipt,
} from "./receipt";
interface ReleaseState {
  current: string | null;
  previous: string | null;
  quarantine: string[];
  highestVersion: number;
  revoked: string[];
  revocationVersion: number;
  channel: "stable" | "preview";
}
export class ReleaseManager {
  state: ReleaseState = {
    current: null,
    previous: null,
    quarantine: [],
    highestVersion: 0,
    revoked: [],
    revocationVersion: 0,
    channel: "stable",
  };
  constructor(
    readonly directory: string,
    readonly config?: {
      metadataUrl: string;
      targetUrl: string;
      rootPath: string;
    },
    readonly verify = verifyDirectory,
  ) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.state = {
        ...this.state,
        ...JSON.parse(
          await readFile(join(this.directory, "state.json"), "utf8"),
        ),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private async persist() {
    const path = join(this.directory, "state.json");
    await writeFile(path + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  async check(channel: "stable" | "preview" = this.state.channel) {
    if (!["stable", "preview"].includes(channel))
      throw new Error("未知更新通道");
    if (!this.config)
      throw new Error("官方更新源尚未配置；当前内置版本继续可用");
    if (
      !this.config.metadataUrl.startsWith("https://") ||
      !this.config.targetUrl.startsWith("https://")
    )
      throw new Error("更新源必须使用 HTTPS");
    const metadataDir = join(this.directory, "metadata");
    await mkdir(metadataDir, { recursive: true });
    try {
      await readFile(join(metadataDir, "root.json"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await cp(this.config.rootPath, join(metadataDir, "root.json"), {
        errorOnExist: true,
        force: false,
      });
    }
    const cachedRoot = JSON.parse(
      await readFile(join(metadataDir, "root.json"), "utf8"),
    );
    const checkedRoot = await trustedRoot(
      this.config.rootPath,
      join(this.directory, "root-chain"),
      cachedRoot.signed.version,
    );
    if (JSON.stringify(checkedRoot.toJSON()) !== JSON.stringify(cachedRoot)) {
      // Canonical library object order can differ; compare parsed root semantics.
      const { Metadata, MetadataKind } = await import("@tufjs/models");
      if (
        !checkedRoot.equals(
          Metadata.fromJSON(MetadataKind.Root, cachedRoot).signed,
        )
      )
        throw new Error("缓存根元数据与可信链不一致");
    }
    const updater = new Updater({
      fetcher: new RecordingFetcher(join(this.directory, "root-chain")),
      metadataDir,
      targetDir: join(this.directory, "downloads"),
      metadataBaseUrl: this.config.metadataUrl,
      targetBaseUrl: this.config.targetUrl,
    });
    await mkdir(join(this.directory, "downloads"), { recursive: true });
    await updater.refresh();
    // Revocations are a separate TUF-authenticated target so they still take effect
    // when a replacement release is unavailable or fails to download.
    const policyInfo = await updater.getTargetInfo("revocations.json");
    if (policyInfo) {
      if (policyInfo.length > 128 * 1024) throw new Error("撤回目录过大");
      const policy = JSON.parse(
        await readFile(await updater.downloadTarget(policyInfo), "utf8"),
      );
      if (
        !Number.isSafeInteger(policy.version) ||
        policy.version < this.state.revocationVersion ||
        !Array.isArray(policy.releases) ||
        policy.releases.length > 2000 ||
        policy.releases.some(
          (id: unknown) =>
            typeof id !== "string" || !/^[-\w.]{1,100}$/.test(id),
        )
      )
        throw new Error("撤回目录无效或存在回放");
      // Revocation is monotonic; disappearance from a later catalog cannot restore code.
      this.state.revoked = [
        ...new Set([...this.state.revoked, ...policy.releases]),
      ] as string[];
      this.state.revocationVersion = policy.version;
      await this.persist();
    }
    this.state.channel = channel;
    await this.persist();
    const info = await updater.getTargetInfo(channel + "/release.json");
    if (!info) throw new Error("目录不存在");
    const path = await updater.downloadTarget(info);
    const manifest = JSON.parse(await readFile(path, "utf8")) as ReleaseSet;
    validateRelease(manifest);
    if (
      manifest.channel !== channel ||
      manifest.version < this.state.highestVersion ||
      this.state.quarantine.includes(manifest.id) ||
      this.state.revoked.includes(manifest.id)
    )
      throw new Error("版本已隔离或存在回放");
    const staging = join(this.directory, manifest.id + ".staging");
    await mkdir(staging, { recursive: true });
    for (const [name, file] of Object.entries(manifest.files)) {
      const target = await updater.getTargetInfo(manifest.id + "/" + name);
      if (
        !target ||
        target.length !== file.size ||
        target.hashes.sha256 !== file.sha256
      )
        throw new Error("目录摘要不一致");
      const downloaded = await updater.downloadTarget(target);
      const destination = join(staging, name);
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(downloaded, destination);
    }
    await this.verify(staging, manifest);
    try {
      await rename(staging, join(this.directory, manifest.id));
    } catch (e) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw e;
      await this.verify(join(this.directory, manifest.id), manifest);
    }
    const root = JSON.parse(
      await readFile(join(metadataDir, "root.json"), "utf8"),
    );
    const receipt: Receipt = {
      rootVersion: root.signed.version,
      targets: JSON.parse(
        await readFile(join(metadataDir, "targets.json"), "utf8"),
      ),
      manifestTarget: channel + "/release.json",
      manifestBytes: (await readFile(path)).toString("base64"),
    };
    await verifyReceipt(
      receipt,
      this.config.rootPath,
      join(this.directory, "root-chain"),
      true,
    );
    await writeFile(
      join(this.directory, manifest.id + ".json"),
      JSON.stringify(receipt),
      { mode: 0o600 },
    );
    this.state.highestVersion = Math.max(
      this.state.highestVersion,
      manifest.version,
    );
    await this.persist();
    return manifest;
  }
  async restoreBundled() {
    this.state.previous = this.state.current;
    this.state.current = null;
    await this.persist();
  }
  async resolve(id: string, activation = false) {
    if (
      !/^[-\w.]{1,100}$/.test(id) ||
      this.state.quarantine.includes(id) ||
      this.state.revoked.includes(id)
    )
      throw new Error("无效或隔离版本");
    if (!this.config)
      throw new Error("没有随应用提供的信任根，拒绝加载外部代码");
    const receipt = JSON.parse(
      await readFile(join(this.directory, id + ".json"), "utf8"),
    );
    const manifest = await verifyReceipt(
      receipt,
      this.config.rootPath,
      join(this.directory, "root-chain"),
      activation,
    );
    if (manifest.id !== id) throw new Error("版本身份不匹配");
    await this.verify(join(this.directory, id), manifest);
    return {
      manifest: manifest as ReleaseSet,
      directory: join(this.directory, id),
    };
  }
  async activate(
    id: string,
    hooks: {
      preflight: (directory: string, manifest: ReleaseSet) => Promise<void>;
      switch: (directory: string, manifest: ReleaseSet) => Promise<void>;
      rollback: () => Promise<void>;
    },
  ) {
    const release = await this.resolve(id, true);
    await hooks.preflight(release.directory, release.manifest);
    const previous = this.state.current;
    try {
      await hooks.switch(release.directory, release.manifest);
      this.state.previous = previous;
      this.state.current = id;
      await this.persist();
    } catch (error) {
      this.state.quarantine.push(id);
      await this.persist();
      await hooks.rollback();
      throw error;
    }
  }
}
