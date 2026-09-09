import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const mockRepo = createRequire(import.meta.url)("@tufjs/repo-mock")
  .default as typeof import("@tufjs/repo-mock").default;
import { ReleaseManager } from "../packages/release/src/manager";
import { UpdateCoordinator } from "../packages/shell/src/update-coordinator";
import type { ReleaseSet } from "../packages/contracts/src/index";
const bytes = "export {}";
const manifest: ReleaseSet = {
  id: "release-2",
  version: 2,
  channel: "stable",
  shellApi: { min: 1, max: 1 },
  protocol: 1,
  schema: { min: 1, max: 1 },
  ui: "ui.js",
  service: "ui.js",
  extension: "ui.js",
  builtins: [],
  files: {
    "ui.js": {
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  },
};
test("TUF verified target set stages and activates without restoring stale business data", async () => {
  const scope = mockRepo(
    [
      { name: "stable/release.json", content: JSON.stringify(manifest) },
      { name: "release-2/ui.js", content: bytes },
    ],
    { baseURL: "https://flowgate.test" },
  );
  const dir = await mkdtemp(join(tmpdir(), "flowgate-tuf-"));
  try {
    const manager = new ReleaseManager(dir, {
      metadataUrl: scope.baseURL + "/metadata/",
      targetUrl: scope.baseURL + "/targets/",
      rootPath: join(scope.cachePath, "root.json"),
    });
    await manager.init();
    const staged = await manager.check();
    assert.equal(staged.id, "release-2");
    let started = false;
    const coordinator = new UpdateCoordinator(manager, {
      preflight: async () => {},
      drain: async () => {},
      stop: async () => {},
      start: async () => {
        started = true;
      },
      restore: async () => {},
      reloadUI: async () => {},
    });
    await coordinator.activate(staged.id);
    assert.equal(started, true);
    assert.equal(manager.state.current, "release-2");
  } finally {
    scope.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed new version is quarantined, restores old code, preserves new user data", async () => {
  const scope = mockRepo(
    [
      { name: "stable/release.json", content: JSON.stringify(manifest) },
      { name: "release-2/ui.js", content: bytes },
    ],
    { baseURL: "https://rollback.flowgate.test" },
  );
  const dir = await mkdtemp(join(tmpdir(), "flowgate-rollback-"));
  try {
    const manager = new ReleaseManager(dir, {
      metadataUrl: scope.baseURL + "/metadata/",
      targetUrl: scope.baseURL + "/targets/",
      rootPath: join(scope.cachePath, "root.json"),
    });
    await manager.init();
    await manager.check();
    const userData = join(dir, "business.json");
    await writeFile(userData, "new user data");
    let restored = 0;
    const coordinator = new UpdateCoordinator(manager, {
      preflight: async () => {},
      drain: async () => {},
      stop: async () => {},
      start: async () => {
        throw new Error("crash");
      },
      restore: async () => {
        restored++;
      },
      reloadUI: async () => {},
    });
    await assert.rejects(() => coordinator.activate(manifest.id));
    assert.equal(restored, 1);
    assert.ok(manager.state.quarantine.includes(manifest.id));
    assert.equal(await readFile(userData, "utf8"), "new user data");
    await assert.rejects(() => manager.resolve(manifest.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
    scope.teardown();
  }
});

test("offline startup revalidates signature receipt even if manifest and bundle are both replaced", async () => {
  const scope = mockRepo(
    [
      { name: "stable/release.json", content: JSON.stringify(manifest) },
      { name: "release-2/ui.js", content: bytes },
    ],
    { baseURL: "https://receipt.flowgate.test" },
  );
  const dir = await mkdtemp(join(tmpdir(), "flowgate-receipt-"));
  try {
    const manager = new ReleaseManager(dir, {
      metadataUrl: scope.baseURL + "/metadata/",
      targetUrl: scope.baseURL + "/targets/",
      rootPath: join(scope.cachePath, "root.json"),
    });
    await manager.init();
    await manager.check();
    const receiptPath = join(dir, manifest.id + ".json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const malicious = {
      ...manifest,
      files: {
        "ui.js": {
          size: 3,
          sha256: createHash("sha256").update("bad").digest("hex"),
        },
      },
    };
    receipt.manifestBytes = Buffer.from(JSON.stringify(malicious)).toString(
      "base64",
    );
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(join(dir, manifest.id, "ui.js"), "bad");
    await assert.rejects(() => manager.resolve(manifest.id));
  } finally {
    scope.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("signed revocations persist even without a replacement and deny offline load", async () => {
  const scope = mockRepo(
    [
      {
        name: "revocations.json",
        content: JSON.stringify({ version: 1, releases: [manifest.id] }),
      },
      { name: "stable/release.json", content: JSON.stringify(manifest) },
    ],
    { baseURL: "https://revocation.flowgate.test" },
  );
  const dir = await mkdtemp(join(tmpdir(), "flowgate-revocation-"));
  const config = {
    metadataUrl: scope.baseURL + "/metadata/",
    targetUrl: scope.baseURL + "/targets/",
    rootPath: join(scope.cachePath, "root.json"),
  };
  try {
    const manager = new ReleaseManager(dir, config);
    await manager.init();
    manager.state.current = manifest.id;
    await assert.rejects(() => manager.check());
    assert.equal(
      manager.state.current,
      manifest.id,
      "does not interrupt the running version",
    );
    assert.deepEqual(manager.state.revoked, [manifest.id]);
    const restarted = new ReleaseManager(dir, config);
    await restarted.init();
    await assert.rejects(() => restarted.resolve(manifest.id), /隔离版本/);
    assert.equal(restarted.state.revocationVersion, 1);
  } finally {
    scope.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});
