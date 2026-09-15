// The copied Electron bundle has a unique identity and never opens a window.
// Local HTTP permission exists only in this disposable parser fixture.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplicationFeed } from "../scripts/application-feed.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
const directory = await mkdtemp(resolve("work/application-feed-"));
const bundle = join(directory, "Electron.app");
execFileSync("/bin/cp", [
  "-R",
  resolve("node_modules/electron/dist/Electron.app"),
  bundle,
]);
const plist = join(bundle, "Contents/Info.plist");
const bundleID = "com.flowgate.feed-probe." + randomUUID();
for (const command of [
  `Set :CFBundleIdentifier ${bundleID}`,
  "Set :CFBundleShortVersionString 1.0.0",
  "Set :CFBundleVersion 900",
  "Add :NSAppTransportSecurity dict",
  "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true",
]) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", command, plist], {
      stdio: "pipe",
    });
  } catch (e) {
    if (!command.endsWith(" dict")) throw e;
  }
}
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--deep", "--sign", "-", bundle],
  { stdio: "pipe" },
);
const appdir = join(directory, "fixture");
await mkdir(appdir);
await writeFile(
  join(appdir, "package.json"),
  JSON.stringify({
    name: "flowgate-feed-probe",
    version: "1.0.0",
    main: "main.cjs",
  }),
);
await writeFile(
  join(appdir, "main.cjs"),
  `const {app}=require('electron'); app.setActivationPolicy('prohibited'); app.setPath('userData',${JSON.stringify(join(directory, "user-data"))}); app.whenReady().then(()=>{});`,
);
const currentFeed = createApplicationFeed({
  version: "1.0.0",
  url: "https://updates.example.invalid/FlowGate.zip",
  notes: "Native parser fixture",
  publishedAt: "2026-09-15T00:00:00Z",
  sha256: "0".repeat(64),
  size: 1,
});
let payload = currentFeed;
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let app;
const results = [];
try {
  app = await electron.launch({
    executablePath: join(bundle, "Contents/MacOS/Electron"),
    args: [appdir],
    env: { ...process.env, FLOWGATE_TEST_DATA: join(directory, "user-data") },
  });
  for (const [name, value] of [
    ["same-version", currentFeed],
    ["malformed-json", "invalid-json"],
    [
      "missing-download-url",
      {
        currentRelease: "1.0.1",
        releases: [{ version: "1.0.1", updateTo: { name: "missing-url" } }],
      },
    ],
    ["recovery-no-update", currentFeed],
  ]) {
    payload = value;
    const result = await app.evaluate(async ({ app, autoUpdater }, url) => {
      await app.whenReady();
      return new Promise((resolve) => {
        let timer;
        const events = [];
        const finish = (kind, message) => {
          clearTimeout(timer);
          autoUpdater.removeListener("error", error);
          autoUpdater.removeListener("update-not-available", none);
          autoUpdater.removeListener("update-available", available);
          resolve({ kind, message, events });
        };
        const error = (e) => finish("error", e.message),
          none = () => finish("current"),
          available = () => events.push("available");
        autoUpdater.on("error", error);
        autoUpdater.on("update-not-available", none);
        autoUpdater.on("update-available", available);
        timer = setTimeout(() => finish("timeout"), 15000);
        try {
          autoUpdater.setFeedURL({ url, serverType: "json" });
          autoUpdater.checkForUpdates();
        } catch (e) {
          finish("throw", e.message);
        }
      });
    }, `http://127.0.0.1:${server.address().port}/releases.json`);
    results.push({ name, ...result });
  }
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  for (const suffix of ["", ".ShipIt"])
    await rm(join(homedir(), "Library/Caches", bundleID + suffix), {
      recursive: true,
      force: true,
    });
}
assert.equal(requests, 4);
assert.deepEqual(
  results.map((result) => result.kind),
  ["current", "error", "error", "current"],
);
assert.ok(
  results.every((result) => result.events.length === 0),
  "No update may be offered or downloaded in this test",
);
await writeFile(
  resolve("work/application-feed-result.json"),
  JSON.stringify(
    {
      passed: true,
      at: new Date().toISOString(),
      scope:
        "Real Electron Squirrel parser in an isolated ad-hoc fixture; no update download or installation; loopback HTTP permitted only in fixture",
      bundleID,
      requests,
      results,
    },
    null,
    2,
  ),
);
console.log(
  "PASS: native Squirrel static metadata, invalid response and retry (no download/install)",
);

await rm(bundle, { recursive: true, force: true });
