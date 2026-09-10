import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createServer as createHTTPS } from "node:https";
import { createServer } from "node:http";
import { connect } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import { openNodeImport } from "./ui-fixtures.mjs";

const directory = await mkdtemp(resolve("work/subscription-e2e-"));
const cert = join(directory, "test.crt"),
  key = join(directory, "test.key"),
  config = join(directory, "openssl.cnf");
await writeFile(
  config,
  "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
);
execFileSync(
  "/usr/bin/openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-config",
    config,
  ],
  { stdio: "ignore" },
);
const uuid = "23456789-abcd-4123-8123-123456789abc";
let body = `vmess=proxy.example:443,method=auto,password=${uuid},tag=Stable,aead=true`,
  etag = '"v1"',
  broken = false;
const requests = [];
const source = createHTTPS(
  { key: await readFile(key), cert: await readFile(cert) },
  (request, response) => {
    requests.push({ validator: request.headers["if-none-match"] });
    if (broken) return response.writeHead(503).end("Unavailable");
    response.setHeader(
      "subscription-userinfo",
      "upload=1024; download=2048; total=1073741824; expire=1900000000",
    );
    response.setHeader("etag", etag);
    if (request.headers["if-none-match"] === etag)
      return response.writeHead(304).end();
    response.end(body);
  },
);
await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
let proxyConnections = 0;
const origin = createServer((_request, response) =>
  response.end("subscription-profile-egress-ok"),
);
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
const proxy = createServer();
proxy.on("connect", (request, socket, head) => {
  proxyConnections++;
  const target = new URL("http://" + request.url);
  const upstream = connect(Number(target.port), target.hostname, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const environment = {
  ...process.env,
  FLOWGATE_TEST_DATA: join(directory, "data"),
  NODE_EXTRA_CA_CERTS: cert,
};
let app = await electron.launch({ args: ["."], env: environment });
const checks = [];
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { visible: w.isVisible(), focusable: w.isFocusable() };
    }),
    { visible: false, focusable: false },
  );
  const port = await isolateProxyPort(page);
  const request = (method, payload) =>
    page.evaluate(
      ({ method, payload }) =>
        window.flowgate.request(method, payload, crypto.randomUUID()),
      { method, payload },
    );
  const snapshot = () => request("snapshot");
  await page.getByRole("button", { name: "节点与订阅", exact: true }).click();
  await page.getByRole("button", { name: "添加订阅", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("订阅名称").fill("Subscription fixture");
  await dialog
    .getByRole("textbox", { name: "订阅链接", exact: true })
    .fill(
      `https://localhost:${source.address().port}/sub?token=private-test-token`,
    );
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog.getByRole("heading", { name: "转换预览" }).waitFor();
  assert.equal((await request("snapshot")).configuration.nodes.length, 0);
  assert.match(await dialog.innerText(), /quantumult-x/);
  await page.screenshot({ path: "work/subscription-preview.png" });
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  let state = await snapshot();
  const sourceId = state.configuration.subscriptions[0].id,
    nodeId = state.configuration.nodes[0].id;
  assert.equal(
    requests.length,
    1,
    "commit uses the reviewed body without a second fetch",
  );
  assert.equal(state.configuration.subscriptions[0].refreshHours, 0);
  assert.equal(state.configuration.subscriptions[0].metadata.total, 1073741824);
  assert.equal(state.configuration.subscriptions[0].url, "");
  assert.equal(state.configuration.subscriptions[0].etag, undefined);
  assert.deepEqual(state.configuration.nodes[0].options, {});
  checks.push(
    "actual HTTPS -> isolated verified parser worker -> read-only UI preview -> single-fetch commit; metadata visible, secrets redacted",
  );

  const before304 = (await request("snapshot")).configuration.revision;
  await page.getByRole("button", { name: "更新", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog
    .getByText("来源未变化，本次仅更新检查时间。", { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "确认更新", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await request("snapshot")).configuration.revision, before304);
  assert.equal(requests.at(-1).validator, '"v1"');
  checks.push(
    "conditional refresh sends persisted ETag and commits a 304 without losing nodes or metadata",
  );

  body = `vmess=rotated.example:8443,method=auto,password=${uuid},tag=Stable,aead=true`;
  etag = '"v2"';
  const update = await request("subscription.preview", { id: sourceId });
  assert.equal(update.nodes[0].id, nodeId);
  assert.equal(update.changes.updated, 1);
  assert.equal(
    (await request("snapshot")).configuration.nodes[0].server,
    "proxy.example",
  );
  await request("subscription.refresh", {
    id: sourceId,
    previewId: update.id,
    reviewed: true,
  });
  state = await snapshot();
  await request("configuration.save", {
    ...state.configuration,
    settings: { ...state.configuration.settings, selectedNode: nodeId },
  });
  body = `vmess=replacement.example:443,method=auto,password=${uuid},tag=Replacement,aead=true`;
  etag = '"v3"';
  const unsafe = await request("subscription.preview", { id: sourceId });
  assert.equal(unsafe.canCommit, false);
  await assert.rejects(
    request("subscription.refresh", {
      id: sourceId,
      previewId: unsafe.id,
      reviewed: true,
    }),
  );
  assert.equal((await request("snapshot")).configuration.nodes[0].id, nodeId);
  broken = true;
  await assert.rejects(request("subscription.preview", { id: sourceId }));
  assert.equal(
    (await request("snapshot")).configuration.nodes[0].server,
    "rotated.example",
  );
  broken = false;
  body = `vmess=rotated.example:8443,method=auto,password=${uuid},tag=Stable,aead=true`;
  const stale = await request("subscription.preview", { id: sourceId });
  state = await snapshot();
  await request("configuration.save", {
    ...state.configuration,
    settings: { ...state.configuration.settings, selectedNode: "direct" },
  });
  await assert.rejects(
    request("subscription.refresh", {
      id: sourceId,
      previewId: stale.id,
      reviewed: true,
    }),
    /配置已变化/,
  );
  checks.push(
    "endpoint rotation preserves IDs; missing active references, HTTP failure and stale preview keep last-good configuration",
  );

  const input = await openNodeImport(page);
  await input.fill(
    `proxies:\n- {name: Local HTTP, type: http, server: 127.0.0.1, port: ${proxy.address().port}}\nproxy-groups:\n- {name: Pick, type: select, proxies: [Local HTTP, DIRECT]}\nrules:\n- IP-CIDR,127.0.0.1/32,Pick\n- MATCH,DIRECT\n`,
  );
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "导入范围" }).click();
  await page.getByRole("option", { name: /完整配置迁移/ }).click();
  await dialog.getByRole("button", { name: "预览转换", exact: true }).click();
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  state = await snapshot();
  assert.equal(state.configuration.groups.length, 1);
  assert.equal(state.configuration.rules.length, 1);
  assert.equal(state.configuration.settings.mode, "manual");
  await request("proxy.connect", {});
  const exec = promisify(execFile);
  const forward = async () =>
    (
      await exec("/usr/bin/curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "8",
        "--noproxy",
        "",
        "--proxy",
        `http://127.0.0.1:${port}`,
        `http://127.0.0.1:${origin.address().port}/`,
      ])
    ).stdout;
  assert.equal(await forward(), "subscription-profile-egress-ok");
  assert.equal(proxyConnections, 1);
  await request("group.select", {
    id: state.configuration.groups[0].id,
    member: "direct",
    revision: state.configuration.revision,
  });
  await request("proxy.connect", {});
  assert.equal(await forward(), "subscription-profile-egress-ok");
  assert.equal(
    proxyConnections,
    1,
    "group selection switches real egress to direct only after explicit apply",
  );
  await request("proxy.disconnect", {});
  const trace = await page.evaluate(() =>
    window.shell.request("diagnostics.trace"),
  );
  assert.ok(!JSON.stringify(trace).includes("private-test-token"));
  checks.push(
    "full-profile UI migration compiles selector/IP rule; actual loopback HTTP reaches chosen proxy; changing member changes real egress after apply",
  );
  await app.close();
  app = await electron.launch({ args: ["."], env: environment });
  page = await app.firstWindow();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  const restored = await page.evaluate(() =>
    window.flowgate.request("snapshot"),
  );
  assert.equal(restored.configuration.groups[0].selected, "direct");
  assert.equal(
    restored.configuration.subscriptions[0].conversion.format,
    "quantumult-x",
  );
  assert.equal(
    restored.configuration.subscriptions[0].metadata.total,
    1073741824,
  );
  checks.push(
    "restart restores converted sources, metadata, strategy groups and selected members",
  );
  await writeFile(
    "work/subscription-result.json",
    JSON.stringify(
      {
        passed: true,
        checks,
        scope:
          "hidden isolated app; local TLS source and loopback forwarding only; no global DNS/routes/proxy changes",
      },
      null,
      2,
    ),
  );
} finally {
  await app.close().catch(() => {});
  await Promise.all(
    [source, origin, proxy].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    ),
  );
}
