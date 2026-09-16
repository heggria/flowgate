import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { verifyArtifacts } from "./artifacts.mjs";
import {
  createApplicationFeed,
  compareApplicationVersions,
} from "./application-feed.mjs";

// Prepares local artifacts only. It never uploads or changes an active update feed.
assert.equal(
  process.platform,
  "darwin",
  "Application release preparation requires macOS",
);
const app = resolve(
  process.env.FLOWGATE_PACKAGE_DIR ?? "work/package/FlowGate.app",
);
const dist = join(app, "Contents/Resources/app/dist");
const manifest = await verifyArtifacts(dist);
assert.equal(manifest.dirty, false, "Build the exact clean candidate first");
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.platform, "darwin");
assert.equal(manifest.arch, "arm64");
execFileSync("git", ["cat-file", "-e", `${manifest.commit}^{commit}`]);
const plist = (key) =>
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
assert.equal(plist("CFBundleIdentifier"), "com.flowgate.desktop");
assert.equal(plist("CFBundleShortVersionString"), manifest.version);
const buildNumber = plist("CFBundleVersion");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const signing = spawnSync(
  "/usr/bin/codesign",
  ["--display", "--verbose=4", app],
  { encoding: "utf8" },
);
assert.equal(signing.status, 0, "Cannot inspect application signing identity");
assert.match(
  signing.stderr,
  /^Authority=Developer ID Application:/m,
  "A Developer ID signed application is required; development archives remain separate",
);
const team = signing.stderr.match(/^TeamIdentifier=(\w+)$/m)?.[1];
assert.ok(team, "A distribution signing team is required");
for (const file of [
  ...[
    "flowgate-bridge",
    "flowgate-helper",
    "flowgate-local-installer",
    "sing-box",
  ].map((name) => join(dist, name)),
  join(app, "Contents/MacOS/flowgate-helper"),
]) {
  const details = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", file],
    { encoding: "utf8" },
  );
  assert.equal(details.status, 0);
  assert.equal(
    details.stderr.match(/^TeamIdentifier=(\w+)$/m)?.[1],
    team,
    `Native signing team mismatch: ${file}`,
  );
}
execFileSync("/usr/bin/xcrun", ["stapler", "validate", app]);
execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
const previousVersion = process.env.FLOWGATE_APPLICATION_PREVIOUS_VERSION;
assert.ok(
  compareApplicationVersions(manifest.version, previousVersion) > 0,
  "Increase the application version, not only CFBundleVersion, before offering an update",
);
assert.ok(
  process.env.FLOWGATE_APPLICATION_NOTES_FILE,
  "Select a release notes file",
);
const notes = await readFile(
  resolve(process.env.FLOWGATE_APPLICATION_NOTES_FILE),
  "utf8",
);
const metadata = {
  version: manifest.version,
  url: process.env.FLOWGATE_APPLICATION_ARCHIVE_URL,
  notes,
  publishedAt: new Date().toISOString(),
};
// Validate operator input before creating an output directory or archive.
createApplicationFeed({ ...metadata, sha256: "0".repeat(64), size: 1 });
const output = resolve(
  process.env.FLOWGATE_APPLICATION_RELEASE_DIR ?? "work/application-release",
);
const relativeOutput = relative(app, output);
assert.ok(
  relativeOutput.startsWith("../"),
  "Release output must be outside the signed application",
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
try {
  const zip = `FlowGate-${manifest.version}-macos-arm64.zip`;
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    join(output, zip),
  ]);
  const bytes = await readFile(join(output, zip));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const feed = createApplicationFeed({
    ...metadata,
    sha256,
    size: bytes.length,
  });
  await writeFile(
    join(output, "releases.json"),
    JSON.stringify(feed, null, 2) + "\n",
  );
  const source = "FlowGate-source.tar.gz";
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    `--output=${join(output, source)}`,
    manifest.commit,
  ]);
  await writeFile(
    join(output, "build-info.json"),
    JSON.stringify(
      {
        ...manifest,
        buildNumber,
        archive: zip,
        sha256,
        size: bytes.length,
        sourceArchive: source,
        previousVersion,
        team,
        developmentOnly: false,
        notarizationValidated: true,
        preparedAt: metadata.publishedAt,
        published: false,
      },
      null,
      2,
    ) + "\n",
  );
  const sums = [];
  for (const file of [zip, source, "releases.json", "build-info.json"])
    sums.push(
      `${createHash("sha256")
        .update(await readFile(join(output, file)))
        .digest("hex")}  ${file}`,
    );
  await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(output);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
