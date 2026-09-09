import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const config = JSON.parse(
  await readFile("src/desktop/update-config.json", "utf8"),
);
assert.equal(config.enabled, true);
assert.ok(config.metadataUrl.startsWith("https://"));
await mkdir("work", { recursive: true });
const work = await mkdtemp(resolve("work/live-update-"));
const fixture = join(work, "app"),
  data = join(work, "userdata");
await mkdir(fixture);
await cp(process.env.FLOWGATE_LIVE_BUILD_DIR ?? "dist", join(fixture, "dist"), {
  recursive: true,
});
await cp("release/trusted-root.json", join(fixture, "dist/trusted-root.json"));
await writeFile(
  join(fixture, "dist/update-config.json"),
  JSON.stringify(config),
);
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({ name: "flowgate-live-update-test", main: "dist/main.cjs" }),
);
const origin = createServer((_req, res) =>
  res.end("live-business-update-forwarding"),
);
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
let app;
const launch = () =>
  electron.launch({
    args: [fixture],
    env: {
      ...process.env,
      FLOWGATE_TEST_DATA: data,
      FLOWGATE_TEST_VISIBLE: "0",
    },
  });
const hidden = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every(
      (w) => !w.isVisible() && !w.isFocusable() && !w.isFocused(),
    ),
  );
try {
  app = await launch();
  let page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  assert.ok(await hidden());
  const candidate = await page.evaluate(() =>
    window.shell.request("release.check"),
  );
  assert.ok(candidate.id);
  const activation = page.evaluate(
    (id) => window.shell.request("release.activate", { id }),
    candidate.id,
  );
  activation.catch(() => {}); // Successful activation replaces the requesting Renderer context.
  await page.waitForTimeout(500);
  await page.waitForFunction(
    async (id) => {
      try {
        const state = await window.shell.request("release.status");
        return !state.updating && state.current === id;
      } catch {
        return false;
      }
    },
    candidate.id,
    { timeout: 30000 },
  );
  const port = await isolateProxyPort(page);
  await page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, crypto.randomUUID()),
  );
  const { stdout } = await promisify(execFile)("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--max-time",
    "15",
    "--noproxy",
    "",
    "--proxy",
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${origin.address().port}/`,
  ]);
  assert.equal(stdout, "live-business-update-forwarding");
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
  );
  assert.ok(await hidden());
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  const restarted = await page.evaluate(() =>
    window.shell.request("release.status"),
  );
  assert.equal(restarted.current, candidate.id);
  assert.ok(await hidden());
  const result = {
    passed: true,
    at: new Date().toISOString(),
    metadataUrl: config.metadataUrl,
    release: candidate.id,
    version: candidate.version,
    checks: [
      "real HTTPS TUF metadata and artifacts",
      "authenticated activation",
      "real proxy request after activation",
      "verified persisted release on restart",
      "hidden non-focusable windows",
    ],
    developerIdSigned: false,
  };
  await writeFile(
    "work/live-update-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await app?.close();
  await new Promise((r) => origin.close(r));
}
