import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { verifyArtifacts } from "./artifacts.mjs";
const app = resolve(
  process.env.FLOWGATE_PACKAGE_DIR ?? "work/package/FlowGate.app",
);
const manifest = await verifyArtifacts(
  join(app, "Contents/Resources/app/dist"),
);
if (manifest.dirty !== false || !/^[a-f0-9]{40}$/.test(manifest.commit ?? ""))
  throw new Error(
    "Release archives require a clean build with an exact source commit",
  );
execFileSync("git", ["cat-file", "-e", `${manifest.commit}^{commit}`]);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const output = resolve(process.env.FLOWGATE_ARCHIVE_DIR ?? "work/artifacts");
await mkdir(dirname(output), { recursive: true });
// Reserve a new directory; never replace artifacts from an earlier release.
await mkdir(output);
try {
  const zip = `FlowGate-${manifest.version}-${manifest.commit.slice(0, 12)}-macos-arm64-dev.zip`;
  execFileSync("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    join(output, zip),
  ]);
  const source = "FlowGate-source.tar.gz";
  execFileSync("git", [
    "archive",
    "--format=tar.gz",
    `--output=${join(output, source)}`,
    manifest.commit,
  ]);
  const digest = async (file) =>
    createHash("sha256")
      .update(await readFile(join(output, file)))
      .digest("hex");
  const sha256 = await digest(zip);
  await writeFile(
    join(output, "build-info.json"),
    JSON.stringify(
      {
        version: manifest.version,
        commit: manifest.commit,
        dirty: manifest.dirty,
        node: manifest.node,
        platform: manifest.platform,
        arch: manifest.arch,
        builtAt: manifest.builtAt,
        developmentOnly: true,
        archive: zip,
        sha256,
        sourceArchive: source,
        sourceSHA256: await digest(source),
      },
      null,
      2,
    ) + "\n",
  );
  const sums = [];
  for (const file of [zip, source, "build-info.json"])
    sums.push(`${await digest(file)}  ${file}`);
  await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(join(output, zip));
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
