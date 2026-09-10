import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rename,
  access,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyArtifacts } from "./artifacts.mjs";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("macOS arm64 required");
const packageMetadata = JSON.parse(await readFile("package.json", "utf8"));
const buildMetadata = await verifyArtifacts("dist");
if (buildMetadata.version !== packageMetadata.version)
  throw new Error(
    "Application version changed after build; rebuild before packaging",
  );
const buildNumber =
  process.env.FLOWGATE_BUILD_NUMBER ?? packageMetadata.version;
if (!/^\d+(\.\d+){0,2}$/.test(buildNumber))
  throw new Error("Invalid numeric build number");
const output = resolve(
  process.env.FLOWGATE_PACKAGE_DIR ?? "dist-app/FlowGate.app",
);
try {
  await access(output);
  throw new Error("Output already exists; choose a new FLOWGATE_PACKAGE_DIR");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
execFileSync("/usr/bin/ditto", [
  "node_modules/electron/dist/Electron.app",
  output,
]);
const contents = join(output, "Contents"),
  resources = join(contents, "Resources");
await mkdir(join(resources, "app"), { recursive: true });
await cp("dist/assets/FlowGate.icns", join(resources, "FlowGate.icns"));
await cp("dist", join(resources, "app/dist"), { recursive: true });
await verifyArtifacts(join(resources, "app/dist"));
await cp("LICENSE", join(resources, "FlowGate-LICENSE"));
await cp("THIRD_PARTY_NOTICES.md", join(resources, "THIRD_PARTY_NOTICES.md"));
await cp("licenses", join(resources, "licenses"), { recursive: true });
await writeFile(
  join(resources, "app/package.json"),
  JSON.stringify({
    name: "flowgate",
    version: packageMetadata.version,
    main: "dist/main.cjs",
  }),
);
await cp("dist/flowgate-helper", join(contents, "MacOS/flowgate-helper"));
await mkdir(join(contents, "Library/LaunchDaemons"), { recursive: true });
await cp(
  "native/com.flowgate.helper.plist",
  join(contents, "Library/LaunchDaemons/com.flowgate.helper.plist"),
);
await rename(
  join(contents, "MacOS/Electron"),
  join(contents, "MacOS/FlowGate"),
);
const plist = join(contents, "Info.plist");
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :CFBundleURLTypes array",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :CFBundleURLTypes:0 dict",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :CFBundleURLTypes:0:CFBundleURLName string com.flowgate.desktop",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
  plist,
]);
execFileSync("/usr/libexec/PlistBuddy", [
  "-c",
  "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string flowgate",
  plist,
]);
for (const [key, value] of Object.entries({
  CFBundleIconFile: "FlowGate.icns",
  CFBundleName: "FlowGate",
  CFBundleExecutable: "FlowGate",
  CFBundleDisplayName: "FlowGate",
  CFBundleIdentifier: "com.flowgate.desktop",
  CFBundleShortVersionString: packageMetadata.version,
  CFBundleVersion: buildNumber,
}))
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :${key} ${value}`,
    plist,
  ]);
const identity = process.env.FLOWGATE_SIGNING_IDENTITY;
if (identity) {
  const nativeBinaries = [
    [join(resources, "app/dist/sing-box"), "com.flowgate.kernel"],
    [join(resources, "app/dist/flowgate-bridge"), "com.flowgate.bridge"],
    [join(contents, "MacOS/flowgate-helper"), "com.flowgate.helper"],
    [join(resources, "app/dist/flowgate-helper"), "com.flowgate.helper"],
  ];
  for (const [path, id] of nativeBinaries)
    execFileSync("/usr/bin/codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      "--identifier",
      id,
      path,
    ]);
  const { sign } = await import("@electron/osx-sign");
  await sign({
    app: output,
    identity,
    platform: "darwin",
    type: "distribution",
    ignore: (file) => nativeBinaries.some(([path]) => path === file),
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: ["com.apple.security.cs.allow-jit"],
    }),
  });
  if (process.env.FLOWGATE_NOTARY_PROFILE) {
    const { notarize } = await import("@electron/notarize");
    await notarize({
      appPath: output,
      keychainProfile: process.env.FLOWGATE_NOTARY_PROFILE,
    });
  }
} else
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    output,
  ]);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]);
for (const [key, expected] of Object.entries({
  CFBundleShortVersionString: packageMetadata.version,
  CFBundleVersion: buildNumber,
})) {
  const actual = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    { encoding: "utf8" },
  ).trim();
  if (actual !== expected) throw new Error(`Packaged ${key} mismatch`);
}
console.log(
  JSON.stringify({
    application: output,
    signedForDistribution: !!identity,
    notarized: !!identity && !!process.env.FLOWGATE_NOTARY_PROFILE,
    helperRequiresApproval: true,
  }),
);
