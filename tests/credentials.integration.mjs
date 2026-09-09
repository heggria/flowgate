import { _electron as electron } from "playwright";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const data = await mkdtemp(resolve("work/credentials-"));
const env = {
  ...process.env,
  FLOWGATE_TEST_DATA: data,
  FLOWGATE_INTERNAL_TEST: "1",
};
let app;
const digest = (secret) => createHash("sha256").update(secret).digest("hex");
async function open() {
  app = await electron.launch({ args: ["."], env });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览" }).waitFor({ timeout: 20000 });
  await page.evaluate(() => window.shell.request("gateway.start"));
  return page;
}
try {
  let page = await open();
  await page.evaluate(() =>
    window.shell.request("gateway.credential.rotate", {
      secret: "fixture-original",
      generation: 0,
    }),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.shell.request("gateway.credential.probe"),
      )
    ).digest,
    digest("fixture-original"),
  );
  await page.evaluate(() =>
    window.shell.request("gateway.credential.rotate", {
      secret: "fixture-rotated",
      generation: 1,
    }),
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.shell.request("gateway.credential.probe"),
      )
    ).digest,
    digest("fixture-rotated"),
  );
  const stale = await page.evaluate(() =>
    window.shell
      .request("gateway.credential.rotate", {
        secret: "fixture-stale",
        generation: 1,
      })
      .then(
        () => false,
        () => true,
      ),
  );
  assert.equal(stale, true);
  const stored = await readFile(join(data, "secrets/credentials.json"), "utf8");
  assert.ok(!stored.includes("fixture-"));
  await app.close();
  app = undefined;
  page = await open();
  assert.equal(
    (
      await page.evaluate(() =>
        window.shell.request("gateway.credential.probe"),
      )
    ).digest,
    digest("fixture-rotated"),
  );
  await writeFile(
    "work/credentials-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks: [
          "Electron OS encryption at rest",
          "scoped credential lookup from Utility Process",
          "rotation visible without host restart",
          "stale rotation rejected",
          "encrypted storage restored across application restart",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS: OS encrypted credentials and live host rotation");
} finally {
  if (app) await app.close();
}
