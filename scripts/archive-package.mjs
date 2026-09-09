import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
const app = resolve(
  process.env.FLOWGATE_PACKAGE_DIR ?? "work/package/FlowGate.app",
);
const manifest = JSON.parse(
  await readFile(
    join(app, "Contents/Resources/app/dist/build-manifest.json"),
    "utf8",
  ),
);
const stamp = (manifest.commit ?? "local").slice(0, 12);
await mkdir("work/artifacts", { recursive: true });
const zip = `FlowGate-${manifest.version}-${stamp}-macos-arm64-dev.zip`;
const path = join("work/artifacts", zip);
try {
  await access(path);
  throw new Error("Archive already exists; never overwrite release artifacts");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
execFileSync("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  app,
  path,
]);
const sha256 = createHash("sha256")
  .update(await readFile(path))
  .digest("hex");
await writeFile(join("work/artifacts", "SHA256SUMS"), `${sha256}  ${zip}\n`);
await writeFile(
  join("work/artifacts", "build-info.json"),
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
      developerIdSigned: false,
      notarized: false,
      archive: zip,
      sha256,
    },
    null,
    2,
  ),
);
console.log(path);
