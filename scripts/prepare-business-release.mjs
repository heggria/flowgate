import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Metadata, MetadataKind } from "@tufjs/models";
import { verifyArtifacts, inventory } from "./artifacts.mjs";
import {
  validateRelease,
  verifyDirectory,
} from "../packages/release/src/loader.ts";
import {
  readPublisherRepository,
  preparePublisher,
} from "../packages/release/src/publisher.ts";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (directory, ...args) =>
  execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function cleanCommit(directory) {
  assert.equal(
    git(directory, "status", "--porcelain", "--untracked-files=normal"),
    "",
    "Source and public baseline must be clean",
  );
  const commit = git(directory, "rev-parse", "HEAD");
  assert.match(commit, /^[a-f0-9]{40}$/);
  return commit;
}
function outside(directory, boundary) {
  const path = relative(boundary, directory);
  assert.ok(
    path === ".." || path.startsWith(".." + sep),
    "Output must be outside build and public baseline",
  );
}
// This entry point accepts only public metadata. It does not load signing keys,
// contact a feed, activate an application or publish anything.
export async function prepareBusinessRelease(options) {
  const source = await realpath(options.sourceDirectory ?? process.cwd());
  const build = await realpath(options.buildDirectory);
  const baseline = await realpath(options.repositoryDirectory);
  const manifestFile = await realpath(options.manifestFile);
  const output = resolve(options.outputDirectory);
  // Resolve the parent to reject a symlink that places output inside protected inputs.
  const actualOutput = join(
    await realpath(resolve(output, "..")),
    output.split(sep).at(-1),
  );
  outside(actualOutput, build);
  outside(actualOutput, baseline);
  const commit = cleanCommit(source),
    baselineCommit = cleanCommit(baseline);
  assert.equal(
    await realpath(git(source, "rev-parse", "--show-toplevel")),
    source,
    "Select the clean source repository root",
  );
  assert.equal(
    await realpath(git(baseline, "rev-parse", "--show-toplevel")),
    baseline,
    "Select the public repository root",
  );
  const branch = git(baseline, "branch", "--show-current");
  assert.ok(
    branch === "updates" || branch === "",
    "Select updates or a detached public checkout",
  );
  assert.equal(
    baselineCommit,
    git(baseline, "rev-parse", "refs/remotes/origin/updates"),
    "Public baseline must be the exact fetched origin/updates commit",
  );
  const origin = git(baseline, "remote", "get-url", "origin");
  assert.ok(
    [
      "https://github.com/heggria/flowgate.git",
      "https://github.com/heggria/flowgate",
      "git@github.com:heggria/flowgate.git",
    ].includes(origin),
    "Select the official public updates repository",
  );
  git(source, "ls-files", "--error-unmatch", "release/trusted-root.json");
  const anchorBytes = await readFile(join(source, "release/trusted-root.json"));
  const root = Metadata.fromJSON(MetadataKind.Root, JSON.parse(anchorBytes));
  const publicRepository = await readPublisherRepository(baseline, root);
  for (const role of ["root", "targets", "snapshot", "timestamp"]) {
    const metadata = publicRepository[role];
    assert.ok(metadata, "Public baseline must contain all published roles");
    assert.equal(
      metadata.signed.isExpired(),
      false,
      `Public ${role} authorization expired`,
    );
  }
  const buildManifest = await verifyArtifacts(build);
  assert.equal(
    buildManifest.dirty,
    false,
    "Build the clean exact candidate first",
  );
  assert.equal(
    buildManifest.commit,
    commit,
    "Build source commit differs from selected clean source",
  );
  assert.equal(buildManifest.platform, "darwin");
  assert.equal(buildManifest.arch, "arm64");
  const packageVersion = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ).version;
  assert.equal(
    buildManifest.version,
    packageVersion,
    "Build version differs from clean source",
  );
  const manifestBytes = await readFile(manifestFile),
    manifest = JSON.parse(manifestBytes);
  validateRelease(manifest);
  assert.deepEqual(manifest.platforms, ["darwin-arm64"]);
  assert.equal(manifest.publisher, "flowgate");
  assert.deepEqual(manifest.shellApi, { min: 2, max: 2 });
  assert.deepEqual(manifest.schema, { min: 2, max: 2 });
  for (const component of ["ui", "service", "extension"])
    assert.equal(
      manifest.components?.[component],
      packageVersion,
      "Component version differs from candidate",
    );
  await verifyDirectory(join(build, "release"), manifest);
  const buildBytes = await readFile(join(build, "build-manifest.json"));
  // mkdir is the ownership boundary: an existing directory is never deleted.
  await mkdir(actualOutput);
  try {
    const request = join(actualOutput, "request");
    await preparePublisher(baseline, request, root, {
      kind: "release",
      manifest,
      artifacts: join(build, "release"),
    });
    assert.equal(
      cleanCommit(source),
      commit,
      "Source changed during preparation",
    );
    assert.equal(
      cleanCommit(baseline),
      baselineCommit,
      "Public baseline changed during preparation",
    );
    await verifyArtifacts(build);
    assert.equal(
      digest(await readFile(join(build, "build-manifest.json"))),
      digest(buildBytes),
      "Build inventory changed during preparation",
    );
    assert.equal(
      digest(await readFile(manifestFile)),
      digest(manifestBytes),
      "Manifest changed during preparation",
    );
    const provenance = {
      schema: 1,
      published: false,
      unsigned: true,
      preparedAt: new Date().toISOString(),
      commit,
      version: packageVersion,
      release: {
        id: manifest.id,
        version: manifest.version,
        channel: manifest.channel,
        shellApi: manifest.shellApi,
        schema: manifest.schema,
        platforms: manifest.platforms,
      },
      buildManifestSHA256: digest(buildBytes),
      manifestSHA256: digest(manifestBytes),
      trustedRootSHA256: digest(anchorBytes),
      baseline: {
        commit: baselineCommit,
        origin,
        rootVersion: publicRepository.root.signed.version,
        targetsVersion: publicRepository.targets.signed.version,
        snapshotVersion: publicRepository.snapshot.signed.version,
        timestampVersion: publicRepository.timestamp.signed.version,
        expires: Object.fromEntries(
          ["root", "targets", "snapshot", "timestamp"].map((role) => [
            role,
            publicRepository[role].signed.expires,
          ]),
        ),
      },
      files: manifest.files,
      requestDirectory: "request",
      signingTargetsSHA256: digest(
        await readFile(join(request, "signing/targets.json")),
      ),
    };
    await writeFile(join(actualOutput, "manifest.json"), manifestBytes, {
      flag: "wx",
    });
    await writeFile(join(actualOutput, "build-manifest.json"), buildBytes, {
      flag: "wx",
    });
    await writeFile(
      join(actualOutput, "provenance.json"),
      JSON.stringify(provenance, null, 2) + "\n",
      { flag: "wx" },
    );
    const sums = await inventory(actualOutput);
    sums["build-manifest.json"] = { sha256: digest(buildBytes) };
    await writeFile(
      join(actualOutput, "SHA256SUMS"),
      Object.entries(sums)
        .map(([name, file]) => `${file.sha256}  ${name}`)
        .join("\n") + "\n",
      { flag: "wx" },
    );
    return provenance;
  } catch (error) {
    await rm(actualOutput, { recursive: true, force: true });
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [
    repositoryDirectory,
    buildDirectory,
    manifestFile,
    outputDirectory,
    sourceDirectory,
  ] = process.argv.slice(2);
  assert.ok(
    repositoryDirectory && buildDirectory && manifestFile && outputDirectory,
    "Usage: node --import tsx scripts/prepare-business-release.mjs <public-updates> <build-directory> <manifest.json> <new-output> [clean-source]",
  );
  const provenance = await prepareBusinessRelease({
    repositoryDirectory,
    buildDirectory,
    manifestFile,
    outputDirectory,
    sourceDirectory,
  });
  console.log(
    JSON.stringify({
      published: false,
      unsigned: true,
      commit: provenance.commit,
      release: provenance.release,
      output: resolve(outputDirectory),
    }),
  );
}
