import { build } from "esbuild";
import { mkdir, copyFile, access, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
await mkdir("dist/release", { recursive: true });
await build({
  entryPoints: {
    main: "src/desktop/main.ts",
    preload: "src/desktop/preload.ts",
    verification: "packages/release/src/verification-worker.ts",
  },
  outdir: "dist",
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
  outdir: "dist/release",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
});
await build({
  entryPoints: ["src/ui/app.tsx"],
  outfile: "dist/release/app.js",
  bundle: true,
  platform: "browser",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await Promise.all(
  ["index.html", "style.css"].map((f) =>
    copyFile("src/ui/" + f, "dist/release/" + f),
  ),
);
await Promise.all(
  ["recovery.html", "recovery.css", "recovery.js"].map((f) =>
    copyFile("src/desktop/" + f, "dist/" + f),
  ),
);
if (process.platform === "darwin") {
  const shared = [
    "native/HelperProtocol.swift",
    "native/Signing.swift",
    "native/ProcessIdentity.swift",
    "native/KernelWatchdog.swift",
    "native/OwnershipJournal.swift",
    "native/NetworkEngine.swift",
  ];
  execFileSync("/usr/bin/swiftc", [
    ...shared,
    "native/Bridge.swift",
    "-o",
    "dist/flowgate-bridge",
  ]);
  execFileSync("/usr/bin/swiftc", [
    ...shared,
    "native/Helper.swift",
    "-o",
    "dist/flowgate-helper",
  ]);
}
try {
  await access("vendor/sing-box");
  await copyFile("vendor/sing-box", "dist/sing-box");
} catch {}

await copyFile(
  "packages/service/src/kernel/telemetry.proto",
  "dist/release/telemetry.proto",
);
const serviceHashes = {};
for (const file of ["service.cjs", "extension.cjs", "gateway.cjs", "telemetry.proto"])
  serviceHashes[file] = createHash("sha256")
    .update(await readFile("dist/release/" + file))
    .digest("hex");
await writeFile("dist/bundled-hashes.json", JSON.stringify(serviceHashes));
await build({
  entryPoints: ["packages/gateway-test/src/host.ts"],
  outfile: "dist/internal/gateway.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

await copyFile(
  "packages/service/src/kernel/telemetry.proto",
  "dist/release/telemetry.proto",
);

await copyFile("src/desktop/update-config.json", "dist/update-config.json");
try {
  await copyFile("release/trusted-root.json", "dist/trusted-root.json");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
