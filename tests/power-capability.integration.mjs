import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { isolateProxyPort } from "./proxy-fixture.mjs";
const directory = await mkdtemp(resolve("work/power-capability-"));
const fixture = join(directory, "app");
await mkdir(fixture);
await cp("dist", join(fixture, "dist"), { recursive: true });
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({ name: "power-capability-fixture", main: "dist/main.cjs" }),
);
const servicePath = join(fixture, "dist/release/service.cjs");
let service = await readFile(servicePath, "utf8");
assert.equal(
  service.split("}, 25e3);").length,
  2,
  "one capability deadline in test fixture",
);
service = service.replace("}, 25e3);", "}, 5e3);");
service =
  `{
  const parent = process.parentPort, send = parent.postMessage.bind(parent);
  const log = kind => require('node:fs').appendFileSync(require('node:path').join(process.env.FLOWGATE_TEST_DATA, 'power-timing.jsonl'), JSON.stringify({kind, at: Date.now()}) + '\\n');
  const methods = new Map();
  parent.on('message', ({data}) => { if (data?.type === 'power') log('power:' + data.suspended); if (data?.type === 'capability.result') log('result:' + methods.get(data.id)); });
  let delayed = false;
  parent.postMessage = (...args) => {
    if (args[0]?.type === 'capability') { methods.set(args[0].id, args[0].method); if (args[0].method === 'native.apply') log('apply-request'); }
    if (!delayed && args[0]?.type === 'capability' && args[0]?.method === 'native.apply') {
      delayed = true;
      log('apply-scheduled');
      setTimeout(() => { log('apply-sent'); send(...args); }, 7000);
    } else send(...args);
  };
}\n` + service;
await writeFile(servicePath, service);
const app = await electron.launch({
  args: [fixture],
  env: { ...process.env, FLOWGATE_TEST_DATA: join(directory, "userdata") },
});
try {
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 20000 });
  await isolateProxyPort(page);
  const connecting = page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, "sleep-pending-apply"),
  );
  connecting.catch(() => {});
  let admitted = false;
  for (let i = 0; i < 50; i++) {
    const snapshot = await page.evaluate(() =>
      window.flowgate.request("snapshot"),
    );
    if (
      snapshot.operations.some(
        (o) => o.id === "sleep-pending-apply" && o.state === "pending",
      )
    ) {
      admitted = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(admitted, true);
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("suspend"));
  await new Promise((r) => setTimeout(r, 6000)); // Longer than the shortened capability deadline.
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
  const result = await connecting;
  assert.equal(result.operation.state, "succeeded");
  assert.equal(result.snapshot.kernel.status, "running");
  let resumed = false;
  for (let i = 0; i < 100; i++) {
    if (
      !(await page.evaluate(() => window.shell.request("release.status")))
        .suspended
    ) {
      resumed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(resumed, true);
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, "sleep-pending-stop"),
  );
  await writeFile(
    "work/power-capability-result.json",
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        scope:
          "injected suspend/resume; 5 second Service capability deadline spans 6 second pause; delayed native apply succeeds once; no OS sleep or global network mutation",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: cross-process capability deadline excludes suspended time",
  );
} catch (error) {
  console.log(
    await readFile(
      join(directory, "userdata/power-timing.jsonl"),
      "utf8",
    ).catch(() => "no timing"),
  );
  throw error;
} finally {
  await app.close();
}
