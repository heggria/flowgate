import { build } from "esbuild";
import { mkdir, copyFile, access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withBuildOutput } from "./scripts/build-output.mjs";
import { sealArtifacts } from "./scripts/artifacts.mjs";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("FlowGate builds require macOS arm64");
await access("vendor/sing-box");
const versionOutput = execFileSync("vendor/sing-box", ["version"], {
  encoding: "utf8",
});
if (!versionOutput.includes("sing-box version 1.14.0"))
  throw new Error("Unexpected kernel version; run npm run setup:kernel");
if (
  !execFileSync("/usr/bin/file", ["vendor/sing-box"], {
    encoding: "utf8",
  }).includes("arm64")
)
  throw new Error("Kernel must support arm64");
await withBuildOutput(async (output) => {
  await mkdir(output + "/release", { recursive: true });
  await mkdir(output + "/assets", { recursive: true });
  await Promise.all(
    [
      "FlowGate.icns",
      "app-icon.png",
      "menuBarTemplate.png",
      "menuBarTemplate@2x.png",
    ].map((name) =>
      copyFile("assets/brand/" + name, output + "/assets/" + name),
    ),
  );
  await build({
    entryPoints: {
      main: "src/desktop/main.ts",
      preload: "src/desktop/preload.ts",
      verification: "packages/release/src/verification-worker.ts",
    },
    outdir: output,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await build({
    entryPoints: {
      service: "packages/service/src/host.ts",
      extension: "packages/extensions/src/host.ts",
      gateway: "packages/gateway-test/src/utility-host.ts",
    },
    outdir: output + "/release",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await build({
    entryPoints: ["src/ui/app.tsx"],
    outfile: output + "/release/app.js",
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await Promise.all(
    ["index.html", "style.css"].map((f) =>
      copyFile("src/ui/" + f, output + "/release/" + f),
    ),
  );
  await Promise.all(
    ["recovery.html", "recovery.css", "recovery.js"].map((f) =>
      copyFile("src/desktop/" + f, output + "/" + f),
    ),
  );
  if (process.platform === "darwin") {
    const shared = [
      "native/HelperProtocol.swift",
      "native/Signing.swift",
      "native/LocalTrust.swift",
      "native/ProcessIdentity.swift",
      "native/KernelWatchdog.swift",
      "native/OwnershipJournal.swift",
      "native/SessionLease.swift",
      "native/NetworkEngine.swift",
    ];
    execFileSync("/usr/bin/swiftc", [
      ...shared,
      "native/Bridge.swift",
      "-o",
      output + "/flowgate-bridge",
    ]);
    execFileSync("/usr/bin/swiftc", [
      ...shared,
      "native/Helper.swift",
      "-o",
      output + "/flowgate-helper",
    ]);
  }
  execFileSync("/usr/bin/swiftc", [
    "native/LocalTrust.swift",
    "native/OwnershipJournal.swift",
    "native/LocalInstaller.swift",
    "-o",
    output + "/flowgate-local-installer",
  ]);
  await copyFile("vendor/sing-box", output + "/sing-box");

  await copyFile(
    "packages/service/src/kernel/telemetry.proto",
    output + "/release/telemetry.proto",
  );
  const serviceHashes = {};
  for (const file of [
    "service.cjs",
    "extension.cjs",
    "gateway.cjs",
    "telemetry.proto",
  ])
    serviceHashes[file] = createHash("sha256")
      .update(await readFile(output + "/release/" + file))
      .digest("hex");
  await writeFile(
    output + "/bundled-hashes.json",
    JSON.stringify(serviceHashes),
  );
  await build({
    entryPoints: ["packages/gateway-test/src/host.ts"],
    outfile: output + "/internal/gateway.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });

  await copyFile(
    "packages/service/src/kernel/telemetry.proto",
    output + "/release/telemetry.proto",
  );

  await copyFile(
    "src/desktop/update-config.json",
    output + "/update-config.json",
  );
  try {
    await copyFile("release/trusted-root.json", output + "/trusted-root.json");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const config = JSON.parse(
    await readFile("src/desktop/update-config.json", "utf8"),
  );
  if (config.enabled) await access(output + "/trusted-root.json");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  let commit = null,
    dirty = true;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    dirty = !!execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      { encoding: "utf8" },
    ).trim();
  } catch {}
  await sealArtifacts(output, {
    version: pkg.version,
    commit,
    dirty,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    builtAt: new Date().toISOString(),
  });
});
