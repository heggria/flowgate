import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const bundle = resolve(
  process.env.FLOWGATE_PACKAGE_DIR ?? "work/package/FlowGate.app",
);
const resource = join(bundle, "Contents/Resources/app");
const build = JSON.parse(
  await readFile(join(resource, "dist/build-manifest.json"), "utf8"),
);
const metadata = JSON.parse(
  await readFile(join(resource, "package.json"), "utf8"),
);
assert.equal(metadata.version, build.version);
const plist = join(bundle, "Contents/Info.plist");
const field = (key) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
    encoding: "utf8",
  }).trim();
assert.equal(field("CFBundleShortVersionString"), metadata.version);
assert.equal(
  field("CFBundleVersion"),
  process.env.FLOWGATE_BUILD_NUMBER ?? metadata.version,
);
assert.equal(
  createHash("sha256")
    .update(await readFile(join(resource, "dist/main.cjs")))
    .digest("hex"),
  build.files["main.cjs"].sha256,
);
assert.equal(field("CFBundleIconFile"), "FlowGate.icns");
assert.deepEqual(
  await readFile(join(bundle, "Contents/Resources/FlowGate.icns")),
  await readFile(join(resource, "dist/assets/FlowGate.icns")),
);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
await mkdir("work", { recursive: true });
const origin = createServer((_req, res) => res.end("packaged-flowgate"));
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
let app;
try {
  app = await electron.launch({
    executablePath: join(bundle, "Contents/MacOS/FlowGate"),
    env: {
      ...process.env,
      FLOWGATE_TEST_DATA: await mkdtemp(resolve("work/package-data-")),
      FLOWGATE_TEST_VISIBLE: "0",
    },
  });
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (w) => w.isVisible() || w.isFocused() || w.isFocusable(),
      ),
    ),
    false,
  );
  const port = await isolateProxyPort(page);
  await page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, crypto.randomUUID()),
  );
  const { stdout } = await promisify(execFile)("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--max-time",
    "10",
    "--noproxy",
    "",
    "--proxy",
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${origin.address().port}/`,
  ]);
  assert.equal(stdout, "packaged-flowgate");
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
  );
  await page.screenshot({ path: "work/package-preview.png" });
  await writeFile(
    "work/package-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        version: metadata.version,
        buildNumber: field("CFBundleVersion"),
        commit: build.commit,
        checks: [
          "packaged version identity",
          "codesign integrity",
          "own application icon matches verified build",
          "built shell digest",
          "hidden packaged window",
          "real proxy forwarding from packaged executable",
        ],
        developerIdSigned: false,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: packaged application identity, hidden launch and real forwarding",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => origin.close(resolve));
}
