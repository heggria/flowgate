import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { Metadata, MetadataKind } from "@tufjs/models";
import {
  createPublisherRoot,
  roleSigner,
  preparePublisher,
  signPublisherTargets,
  finalizePublisher,
} from "../packages/release/src/publisher.ts";
import { sealArtifacts, inventory } from "../scripts/artifacts.mjs";
import { prepareBusinessRelease } from "../scripts/prepare-business-release.mjs";
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-business-prepare-"));
  const source = join(directory, "source"),
    baseline = join(directory, "baseline"),
    build = join(directory, "build");
  const signers = Object.fromEntries(
    ["root", "targets", "snapshot", "timestamp"].map((role) => [
      role,
      roleSigner(generateKeyPairSync("ed25519").privateKey),
    ]),
  );
  const root = createPublisherRoot(
    Object.fromEntries(
      Object.entries(signers).map(([role, signer]) => [role, signer.key]),
    ),
    signers.root,
  );
  await mkdir(join(source, "release"), { recursive: true });
  await writeFile(
    join(source, "release/trusted-root.json"),
    JSON.stringify(root.toJSON()),
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ version: "0.3.3" }),
  );
  git(source, "init", "-q");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture source",
  );
  const commit = git(source, "rev-parse", "HEAD");
  await mkdir(join(build, "release"), { recursive: true });
  for (const name of [
    "main.cjs",
    "preload.cjs",
    "verification.cjs",
    "sing-box",
    "flowgate-bridge",
    "flowgate-helper",
    "flowgate-local-installer",
    "assets/FlowGate.icns",
    "assets/menuBarTemplate.png",
    "assets/menuBarTemplate@2x.png",
    "assets/app-icon.png",
    "release/index.html",
    "release/service.cjs",
    "release/extension.cjs",
  ]) {
    await mkdir(join(build, name, ".."), { recursive: true });
    await writeFile(join(build, name), "fixture " + name);
  }
  await sealArtifacts(build, {
    version: "0.3.3",
    commit,
    dirty: false,
    platform: "darwin",
    arch: "arm64",
    builtAt: new Date().toISOString(),
  });
  const builtins = [
    ...JSON.parse(
      await readFile(
        resolve("packages/contracts/src/builtin-catalog.json"),
        "utf8",
      ),
    ),
    ...JSON.parse(
      await readFile(
        resolve("packages/contracts/src/service-catalog.json"),
        "utf8",
      ),
    ),
  ].map(({ id, version, capabilities, permissions, contributions }) => ({
    id,
    version,
    capabilities,
    permissions,
    contributions,
  }));
  const manifest = {
    id: "business-fixture",
    version: 2,
    channel: "preview",
    publisher: "flowgate",
    platforms: ["darwin-arm64"],
    components: { ui: "0.3.3", service: "0.3.3", extension: "0.3.3" },
    shellApi: { min: 2, max: 2 },
    protocol: 1,
    schema: { min: 2, max: 2 },
    ui: "index.html",
    service: "service.cjs",
    extension: "extension.cjs",
    catalogVersion: 1,
    builtins,
    files: await inventory(join(build, "release")),
  };
  const bootstrap = join(directory, "bootstrap");
  await mkdir(join(bootstrap, "metadata"), { recursive: true });
  for (const name of ["root.json", "1.root.json"])
    await writeFile(
      join(bootstrap, "metadata", name),
      JSON.stringify(root.toJSON()),
    );
  const request = join(directory, "initial-request");
  await preparePublisher(bootstrap, request, root, {
    kind: "release",
    artifacts: join(build, "release"),
    manifest: { ...manifest, id: "business-previous", version: 1 },
  });
  await signPublisherTargets(request, root, signers.targets);
  await finalizePublisher(request, baseline, root, signers, false, bootstrap);
  git(baseline, "init", "-q", "-b", "updates");
  git(
    baseline,
    "remote",
    "add",
    "origin",
    "https://github.com/heggria/flowgate.git",
  );
  git(baseline, "add", ".");
  git(
    baseline,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture public baseline",
  );
  git(
    baseline,
    "update-ref",
    "refs/remotes/origin/updates",
    git(baseline, "rev-parse", "HEAD"),
  );
  const manifestFile = join(directory, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest));
  return {
    directory,
    signers,
    source,
    baseline,
    build,
    manifest,
    manifestFile,
    options: {
      sourceDirectory: source,
      buildDirectory: build,
      repositoryDirectory: baseline,
      manifestFile,
      outputDirectory: join(directory, "prepared"),
    },
  };
}
const missing = async (path) =>
  assert.rejects(access(path), { code: "ENOENT" });
test("prepares public unsigned request, exact hashes and clean source/baseline provenance", async () => {
  const f = await fixture();
  try {
    const result = await prepareBusinessRelease(f.options);
    assert.equal(result.published, false);
    assert.equal(result.unsigned, true);
    assert.equal(result.commit, git(f.source, "rev-parse", "HEAD"));
    assert.equal(result.baseline.commit, git(f.baseline, "rev-parse", "HEAD"));
    assert.equal(result.baseline.targetsVersion, 1);
    const targets = JSON.parse(
      await readFile(
        join(f.options.outputDirectory, "request/signing/targets.json"),
        "utf8",
      ),
    );
    assert.deepEqual(targets.signatures, []);
    assert.ok(targets.signed.targets["preview/release.json"]);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(f.options.outputDirectory, "manifest.json"),
          "utf8",
        ),
      ),
      f.manifest,
    );
    const provenance = JSON.parse(
      await readFile(
        join(f.options.outputDirectory, "provenance.json"),
        "utf8",
      ),
    );
    assert.deepEqual(provenance, result);
    assert.match(
      await readFile(join(f.options.outputDirectory, "SHA256SUMS"), "utf8"),
      /provenance.json/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("prepares a macOS candidate on a Linux signing host", async () => {
  const f = await fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const result = await prepareBusinessRelease(f.options);
    assert.deepEqual(result.release.platforms, ["darwin-arm64"]);
    assert.equal(result.unsigned, true);
  } finally {
    Object.defineProperty(process, "platform", platform);
    await rm(f.directory, { recursive: true, force: true });
  }
});
for (const scenario of [
  "dirty-source",
  "dirty-build",
  "wrong-commit",
  "tampered-build",
  "incompatible-manifest",
  "wrong-component",
  "non-increasing",
  "dirty-baseline",
  "local-ahead-baseline",
  "wrong-origin",
  "tampered-manifest",
  "wrong-build-version",
  "invalid-version",
  "reused-id",
  "expired-baseline",
  "tampered-public-metadata",
  "existing-output",
])
  test(
    "rejects " + scenario + " without publishing or leaving a partial request",
    async () => {
      const f = await fixture();
      try {
        if (scenario === "reused-id") f.manifest.id = "business-previous";
        if (
          ["expired-baseline", "tampered-public-metadata"].includes(scenario)
        ) {
          const path = join(f.baseline, "metadata/timestamp.json");
          const metadata = Metadata.fromJSON(
            MetadataKind.Timestamp,
            JSON.parse(await readFile(path, "utf8")),
          );
          if (scenario === "expired-baseline") {
            metadata.signed.expires = "2000-01-01T00:00:00Z";
            metadata.sign(f.signers.timestamp.sign, true);
          } else {
            metadata.signed.version += 1;
          }
          await writeFile(path, JSON.stringify(metadata.toJSON()));
          git(f.baseline, "add", ".");
          git(
            f.baseline,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "modified public fixture",
          );
          git(
            f.baseline,
            "update-ref",
            "refs/remotes/origin/updates",
            git(f.baseline, "rev-parse", "HEAD"),
          );
        }
        if (scenario === "local-ahead-baseline") {
          await writeFile(join(f.baseline, "README.md"), "local-only change");
          git(f.baseline, "add", ".");
          git(
            f.baseline,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "unpublished baseline change",
          );
        }
        if (scenario === "dirty-source")
          await writeFile(join(f.source, "untracked"), "dirty");
        if (scenario === "dirty-baseline")
          await writeFile(join(f.baseline, "metadata/extra"), "dirty");
        if (scenario === "tampered-manifest")
          f.manifest.files["service.cjs"].sha256 = "0".repeat(64);
        if (scenario === "invalid-version") f.manifest.version = -1;
        if (scenario === "wrong-build-version") {
          const m = JSON.parse(
            await readFile(join(f.build, "build-manifest.json"), "utf8"),
          );
          m.version = "0.2.0";
          await writeFile(
            join(f.build, "build-manifest.json"),
            JSON.stringify(m),
          );
        }
        if (scenario === "wrong-origin")
          git(
            f.baseline,
            "remote",
            "set-url",
            "origin",
            "https://example.invalid/repo.git",
          );
        if (scenario === "tampered-build")
          await writeFile(join(f.build, "release/service.cjs"), "modified");
        if (["dirty-build", "wrong-commit"].includes(scenario)) {
          const m = JSON.parse(
            await readFile(join(f.build, "build-manifest.json"), "utf8"),
          );
          if (scenario === "dirty-build") m.dirty = true;
          else m.commit = "0".repeat(40);
          await writeFile(
            join(f.build, "build-manifest.json"),
            JSON.stringify(m),
          );
        }
        if (scenario === "incompatible-manifest")
          f.manifest.shellApi = { min: 1, max: 1 };
        if (scenario === "wrong-component")
          f.manifest.components.service = "0.2.0";
        if (scenario === "non-increasing") f.manifest.version = 1;
        await writeFile(f.manifestFile, JSON.stringify(f.manifest));
        if (scenario === "existing-output") {
          await mkdir(f.options.outputDirectory);
          await writeFile(join(f.options.outputDirectory, "keep"), "existing");
        }
        await assert.rejects(prepareBusinessRelease(f.options));
        if (scenario === "existing-output")
          assert.equal(
            await readFile(join(f.options.outputDirectory, "keep"), "utf8"),
            "existing",
          );
        else await missing(f.options.outputDirectory);
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    },
  );

test("accepts a detached worktree only at the fetched updates commit", async () => {
  const f = await fixture();
  try {
    const commit = git(f.baseline, "rev-parse", "HEAD");
    git(f.baseline, "update-ref", "refs/remotes/origin/updates", commit);
    git(f.baseline, "checkout", "--detach", commit);
    const result = await prepareBusinessRelease(f.options);
    assert.equal(result.baseline.commit, commit);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
