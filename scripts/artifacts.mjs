import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function inventory(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (name === "build-manifest.json") continue;
    if (entry.isDirectory())
      Object.assign(
        files,
        await inventory(join(directory, entry.name), name + "/"),
      );
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name));
      files[name] = {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } else throw new Error(`Unsupported build entry: ${name}`);
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function verifyArtifacts(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, "build-manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== 1 ||
    JSON.stringify(await inventory(directory)) !==
      JSON.stringify(manifest.files)
  )
    throw new Error(
      "Build contents differ from the verified inventory; rebuild before packaging",
    );
  for (const name of [
    "main.cjs",
    "preload.cjs",
    "assets/FlowGate.icns",
    "assets/menuBarTemplate.png",
    "assets/menuBarTemplate@2x.png",
    "assets/app-icon.png",
    "verification.cjs",
    "sing-box",
    "flowgate-bridge",
    "flowgate-helper",
    "flowgate-local-installer",
    "release/index.html",
    "release/service.cjs",
  ])
    if (!manifest.files[name])
      throw new Error(`Required build artifact missing: ${name}`);
  return manifest;
}
export async function sealArtifacts(directory, metadata) {
  await writeFile(
    join(directory, "build-manifest.json"),
    JSON.stringify(
      { schema: 1, ...metadata, files: await inventory(directory) },
      null,
      2,
    ) + "\n",
  );
  return verifyArtifacts(directory);
}
