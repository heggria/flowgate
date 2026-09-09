import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Updater } from "tuf-js";
const exec = promisify(execFile);

test("publisher CLI, online-only renewal and full key rotation work with the real TUF client", async () => {
  const work = await mkdtemp(join(tmpdir(), "flowgate-publisher-cli-"));
  const keys = join(work, "keys"),
    bootstrap = join(work, "bootstrap");
  const run = (...args) =>
    exec(process.execPath, [
      "--import",
      "tsx",
      resolve("scripts/tuf-cli.mjs"),
      ...args,
    ]);
  let server, serving;
  try {
    await run("init", bootstrap, keys);
    assert.equal((await stat(join(keys, "root.pem"))).mode & 0o777, 0o600);
    await assert.rejects(run("init", bootstrap, keys));
    const artifacts = join(work, "artifacts"),
      manifestPath = join(work, "manifest.json");
    await mkdir(artifacts);
    const bytes = Buffer.from("export {};\n");
    await writeFile(join(artifacts, "entry.js"), bytes);
    const manifest = {
      id: "cli-one",
      version: 1,
      channel: "preview",
      platforms: ["darwin-arm64"],
      shellApi: { min: 1, max: 1 },
      protocol: 1,
      schema: { min: 1, max: 1 },
      ui: "entry.js",
      service: "entry.js",
      extension: "entry.js",
      builtins: [],
      files: {
        "entry.js": {
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const first = join(work, "first");
    await run("publish", bootstrap, keys, first, artifacts, manifestPath);
    await assert.rejects(
      run(
        "publish",
        first,
        keys,
        join(work, "duplicate"),
        artifacts,
        manifestPath,
      ),
      /immutable/,
    );
    const online = join(work, "online"),
      anchor = join(keys, "trusted-root.json");
    await mkdir(online, { mode: 0o700 });
    for (const role of ["snapshot", "timestamp"])
      await copyFile(join(keys, role + ".pem"), join(online, role + ".pem"));
    await copyFile(anchor, join(online, "trusted-root.json"));
    await assert.rejects(
      run(
        "publish",
        first,
        online,
        join(work, "unauthorized"),
        artifacts,
        manifestPath,
      ),
    );
    serving = join(work, "refreshed");
    await run("refresh", first, online, serving, anchor);
    assert.deepEqual(
      await readFile(join(first, "metadata/1.targets.json")),
      await readFile(join(serving, "metadata/1.targets.json")),
    );
    server = createServer(async (req, res) => {
      try {
        const name = new URL(req.url, "http://localhost").pathname;
        res.end(await readFile(join(serving, name)));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const metadataDir = join(work, "client"),
      targetDir = join(work, "downloads");
    await mkdir(metadataDir);
    await mkdir(targetDir);
    await copyFile(anchor, join(metadataDir, "root.json"));
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = () =>
      new Updater({
        metadataDir,
        targetDir,
        metadataBaseUrl: base + "/metadata/",
        targetBaseUrl: base + "/targets/",
      });
    let updater = client();
    await updater.refresh();
    assert.deepEqual(
      await readFile(
        await updater.downloadTarget(
          await updater.getTargetInfo("cli-one/entry.js"),
        ),
      ),
      bytes,
    );
    const promoted = join(work, "promoted");
    await run("promote", serving, keys, promoted, "cli-one");
    const nextKeys = join(work, "next-keys"),
      rotated = join(work, "rotated");
    await run("rotate", promoted, keys, rotated, nextKeys);
    serving = rotated;
    updater = client();
    await updater.refresh();
    assert.equal(
      JSON.parse(await readFile(join(metadataDir, "root.json"), "utf8")).signed
        .version,
      2,
    );
    const stable = JSON.parse(
      await readFile(
        await updater.downloadTarget(
          await updater.getTargetInfo("stable/release.json"),
        ),
        "utf8",
      ),
    );
    assert.equal(stable.channel, "stable");
    const revoked = join(work, "revoked");
    await run("revoke", serving, nextKeys, revoked, "cli-one");
    serving = revoked;
    updater = client();
    await updater.refresh();
    assert.equal(await updater.getTargetInfo("stable/release.json"), undefined);
    const policy = JSON.parse(
      await readFile(
        await updater.downloadTarget(
          await updater.getTargetInfo("revocations.json"),
        ),
        "utf8",
      ),
    );
    assert.deepEqual(policy.releases, ["cli-one"]);
    assert.equal(
      JSON.parse(await readFile(join(keys, "trusted-root.json"), "utf8")).signed
        .version,
      1,
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await rm(work, { recursive: true, force: true });
  }
});
