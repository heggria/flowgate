import { egressFixture } from "./egress-fixture.mjs";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import { _electron as electron } from "playwright";
import { tufHandlers } from "@tufjs/repo-mock";
import { fixtureRepository } from "./tuf-fixture.mjs";
import { createServer } from "node:https";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
await mkdir("work", { recursive: true });
const results = [];
for (const variant of process.env.FLOWGATE_UPDATE_VARIANTS?.split(",") ?? [
  "ui",
  "service",
  "rollback",
  "apply",
  "delayed-service",
  "delayed-extension",
  "delayed-gateway",
  "delayed-renderer",
  "unresponsive-service",
  "egress",
]) {
  const work = await mkdtemp(resolve("work/update-" + variant + "-"));
  const fixture = join(work, "app");
  await mkdir(fixture);
  await cp("dist", join(fixture, "dist"), { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ name: "flowgate-test", main: "dist/main.cjs" }),
  );
  const files = {};
  const targets = [];
  const id = "test-" + variant + "-2";
  for (const name of await readdir("dist/release")) {
    let bytes = await readFile(join("dist/release", name));
    if (
      name ===
      (variant === "ui" || variant === "delayed-renderer"
        ? "app.js"
        : variant === "delayed-extension"
          ? "extension.cjs"
          : variant === "delayed-gateway"
            ? "gateway.cjs"
            : "service.cjs")
    )
      bytes = Buffer.concat([
        Buffer.from(
          variant === "rollback"
            ? "if(process.env.FLOWGATE_PREFLIGHT!=='1')throw new Error('Injected startup failure');\n"
            : variant === "unresponsive-service"
              ? "if(process.env.FLOWGATE_PREFLIGHT!=='1')setTimeout(()=>{while(true){}},4000);\n"
              : variant.startsWith("delayed-") && variant !== "delayed-renderer"
                ? "if(process.env.FLOWGATE_PREFLIGHT!=='1')setTimeout(()=>process.exit(17),4000);\n"
                : "// independent update fixture\n",
        ),
        bytes,
      ]);
    files[name] = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    targets.push({ name: id + "/" + name, content: bytes });
  }
  const manifest = {
    id,
    version: 2,
    channel: "stable",
    shellApi: { min: 2, max: 2 },
    protocol: 1,
    schema: { min: 2, max: 2 },
    ui: "index.html",
    service: "service.cjs",
    extension: "extension.cjs",
    catalogVersion: 1,
    builtins: [
      ...JSON.parse(
        await readFile("packages/contracts/src/builtin-catalog.json", "utf8"),
      ),
      ...JSON.parse(
        await readFile("packages/contracts/src/service-catalog.json", "utf8"),
      ),
    ].map(({ id, version, capabilities, permissions, contributions }) => ({
      id,
      version,
      capabilities,
      permissions,
      contributions,
    })),
    files,
  };
  targets.push({
    name: "stable/release.json",
    content: JSON.stringify(manifest),
  });
  const repo = fixtureRepository(targets);
  const handlers = tufHandlers(repo, {});
  const config = join(work, "openssl.cnf");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  const key = join(work, "server.key"),
    cert = join(work, "server.crt");
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
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => {
      const handler = handlers.find((h) => h.path === req.url);
      if (!handler) {
        res.writeHead(404).end();
        return;
      }
      const result = handler.fn();
      res
        .writeHead(result.statusCode, {
          "content-type": result.contentType ?? "application/json",
        })
        .end(result.response);
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `https://localhost:${server.address().port}`;
  await writeFile(
    join(fixture, "dist/trusted-root.json"),
    JSON.stringify(repo.rootMeta.toJSON()),
  );
  await writeFile(
    join(fixture, "dist/update-config.json"),
    JSON.stringify({
      enabled: true,
      metadataUrl: base + "/metadata/",
      targetUrl: base + "/targets/",
    }),
  );
  const realEgress = variant === "egress" ? await egressFixture() : undefined;
  const launchOptions = {
    args: [fixture],
    env: {
      ...process.env,
      ...(realEgress ? { FLOWGATE_INTERNAL_UPSTREAM: realEgress.url } : {}),
      NODE_EXTRA_CA_CERTS: cert,
      FLOWGATE_TEST_DATA: join(work, "userdata"),
      FLOWGATE_INTERNAL_TEST: "1",
      FLOWGATE_MODEL_TOKEN: "internal-update-fixture",
      FLOWGATE_STRESS_CHUNKS: "2000",
    },
  };
  let app = await electron.launch(launchOptions);
  try {
    // Trust only this isolated HTTPS fixture's certificate in Chromium networking.
    await app.evaluate(
      ({ session }, pem) => {
        session.defaultSession.setCertificateVerifyProc(
          ({ hostname, certificate }, done) => {
            done(
              hostname === "localhost" &&
                certificate.data.replace(/\s/g, "") === pem.replace(/\s/g, "")
                ? 0
                : -3,
            );
          },
        );
      },
      await readFile(cert, "utf8"),
    );
    let page = await app.firstWindow();
    await page
      .getByRole("heading", { name: "概览" })
      .waitFor({ timeout: 20000 });
    await isolateProxyPort(page);
    const before = await page.evaluate(() =>
      window.flowgate.request("snapshot"),
    );
    if (realEgress) {
      await page.evaluate(async (proxyPort) => {
        await window.flowgate.request(
          "subscription.import",
          {
            text: JSON.stringify({
              outbounds: [
                {
                  type: "http",
                  tag: "gateway-route",
                  server: "127.0.0.1",
                  server_port: proxyPort,
                },
              ],
            }),
          },
          "egress-import",
        );
        const snapshot = await window.flowgate.request("snapshot");
        await window.flowgate.request(
          "configuration.save",
          {
            revision: snapshot.configuration.revision,
            rules: [],
            settings: {
              ...snapshot.configuration.settings,
              selectedNode: snapshot.configuration.nodes[0].id,
              finalOutbound: "select",
            },
          },
          "egress-select",
        );
      }, realEgress.proxyPort);
    }
    await page.evaluate(async () => {
      const state = await window.flowgate.request("snapshot");
      await window.flowgate.request(
        "extensions.setEnabled",
        {
          id: "builtin.tailscale",
          enabled: false,
          revision: state.extensionRevision,
        },
        "update-disable-extension",
      );
    });
    await page.evaluate(() =>
      window.flowgate.request("proxy.connect", {}, crypto.randomUUID()),
    );
    const kernel = await page.evaluate(
      async () => (await window.flowgate.request("snapshot")).kernel,
    );
    const candidate = await page.evaluate(() =>
      window.shell.request("release.check"),
    );
    assert.equal(candidate.id, id);
    if (variant === "ui") {
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "扩展", exact: true })
        .click();
      await page.getByRole("button", { name: "管理更新", exact: true }).click();
      await page.getByRole("button", { name: "检查更新", exact: true }).click();
      await page
        .getByRole("region", { name: "候选版本详情" })
        .getByRole("heading", { name: "可用更新", exact: true })
        .waitFor();
    }

    await page.evaluate(() => window.shell.request("gateway.start"));
    const gatewayBefore = await page.evaluate(() =>
      window.shell.request("gateway.status"),
    );
    const streamResponse = await fetch(
      `http://127.0.0.1:${gatewayBefore.port}/v1/mock`,
      {
        method: "POST",
        headers: { authorization: "Bearer internal-update-fixture" },
      },
    );
    assert.equal(
      streamResponse.status,
      200,
      JSON.stringify(
        await page.evaluate(() => window.shell.request("gateway.status")),
      ),
    );
    let streamBytes = 0;
    const reading = (async () => {
      for await (const chunk of streamResponse.body)
        streamBytes += chunk.length;
    })();
    if (variant === "apply") {
      await page.evaluate(() => {
        window.concurrentApply = window.flowgate.request(
          "proxy.connect",
          {},
          "concurrent-apply",
        );
        window.concurrentApply.catch(() => {});
      });
      let pending = false;
      for (let n = 0; n < 100; n++) {
        const state = JSON.parse(
          await readFile(join(work, "userdata/business/state.json"), "utf8"),
        );
        if (
          state.operations.some(
            (operation) =>
              operation.id === "concurrent-apply" &&
              operation.state === "pending",
          )
        ) {
          pending = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        pending,
        true,
        "native apply must be pending when activation starts",
      );
    }
    const activation = page.evaluate(
      (id) => window.shell.request("release.activate", { id }),
      id,
    );
    activation.catch(() => {});
    await page.waitForTimeout(500);
    await page
      .getByRole("heading", { name: "概览" })
      .waitFor({ timeout: 20000 });
    const deadline = Date.now() + 25000;
    let settled = false;
    while (Date.now() < deadline) {
      try {
        const state = await page.evaluate(() =>
          window.shell.request("release.status"),
        );
        if (
          !state.updating &&
          (state.current === id || state.quarantine.includes(id))
        ) {
          settled = true;
          break;
        }
      } catch {}
      await page.waitForTimeout(100);
    }
    assert.equal(settled, true, "update must settle");
    await reading;
    assert.ok(streamBytes > 1000000, "real stream drained through update");
    const gatewayAfter = await page.evaluate(() =>
      window.shell.request("gateway.status"),
    );
    assert.equal(
      gatewayAfter.lifecycle,
      "ready",
      JSON.stringify({ variant, gatewayBefore, gatewayAfter }),
    );
    if (variant === "ui") assert.equal(gatewayAfter.port, gatewayBefore.port);
    if (variant === "ui" || variant === "service") {
      const trace = await page.evaluate(() =>
        window.shell.request("diagnostics.trace"),
      );
      const stoppedUI = trace.find(
        (e) =>
          e.name === "Renderer:overview" &&
          e.status === "stopped" &&
          e.context.releaseSet === "bundled",
      );
      const readyUI = trace.find(
        (e) =>
          e.name === "Renderer:overview" &&
          e.status === "ready" &&
          e.context.releaseSet === id,
      );
      assert.ok(stoppedUI, "old UI module records release before navigation");
      assert.ok(
        readyUI,
        "new UI records its own Release Set even when the old Service stays running",
      );
      assert.notEqual(
        stoppedUI.context.pluginInstance,
        readyUI.context.pluginInstance,
      );
      assert.notEqual(stoppedUI.context.epoch, readyUI.context.epoch);
      assert.ok(Number.isSafeInteger(readyUI.context.configRevision));
      assert.ok(readyUI.context.moduleVersions.overview);
    }
    if (variant.startsWith("delayed-") || variant === "unresponsive-service") {
      assert.equal(
        (await page.evaluate(() => window.shell.request("release.status")))
          .current,
        id,
        "candidate must activate successfully before the injected runtime failure",
      );
      const deadline = Date.now() + 50000;
      let reverted = false,
        rendererCrashes = 0,
        nextCrash = Date.now();
      while (Date.now() < deadline) {
        if (
          variant === "delayed-renderer" &&
          rendererCrashes < 3 &&
          Date.now() >= nextCrash
        ) {
          const replacement = app.waitForEvent("window", { timeout: 15000 });
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer(),
          );
          page = await replacement;
          await page
            .getByRole("heading", { name: "概览" })
            .waitFor({ timeout: 15000 });
          rendererCrashes++;
          nextCrash = Date.now() + 1500;
        }
        try {
          page = app.windows().at(-1);
          const state = await page.evaluate(() =>
            window.shell.request("release.status"),
          );
          if (
            !state.updating &&
            state.current === null &&
            state.quarantine.includes(id)
          ) {
            await page
              .getByRole("heading", { name: "概览" })
              .waitFor({ timeout: 5000 });
            reverted = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.equal(
        reverted,
        true,
        "runtime crash loop must quarantine and restore bundled UI and hosts: " +
          (await page.locator("body").innerText()),
      );
      const persisted = JSON.parse(
        await readFile(join(work, "userdata/releases/state.json"), "utf8"),
      );
      assert.equal(persisted.current, null);
      assert.ok(persisted.quarantine.includes(id));
    }
    const status = await page.evaluate(() =>
      window.shell.request("release.status"),
    );
    const after = await page.evaluate(() =>
      window.flowgate.request("snapshot"),
    );
    assert.equal(
      after.extensions.find((entry) => entry.id === "builtin.tailscale").status,
      "stopped",
      "disabled package survives update/rollback",
    );
    assert.equal(
      after.extensions.find((entry) => entry.id === "builtin.tailscale")
        .desiredEnabled,
      false,
    );
    if (variant !== "apply")
      assert.equal(
        after.kernel.pid,
        kernel.pid,
        "kernel must survive version switching",
      );
    if (variant === "ui") {
      assert.equal(after.epoch, before.epoch);
      assert.equal(status.current, id);
    } else if (
      variant === "service" ||
      variant === "apply" ||
      variant === "egress"
    ) {
      assert.notEqual(after.epoch, before.epoch);
      assert.equal(status.current, id);
    } else {
      assert.ok(status.quarantine.includes(id));
      assert.equal(status.current, null);
    }
    if (variant === "apply") {
      assert.equal(after.kernel.operationId, "concurrent-apply");
      assert.equal(
        after.operations.filter(
          (operation) => operation.id === "concurrent-apply",
        ).length,
        1,
      );
      assert.equal(
        after.operations.find(
          (operation) => operation.id === "concurrent-apply",
        ).state,
        "succeeded",
      );
      await page.evaluate(() =>
        window.flowgate.request("proxy.connect", {}, "concurrent-apply"),
      );
      assert.equal(
        (await page.evaluate(() => window.flowgate.request("snapshot"))).kernel
          .pid,
        after.kernel.pid,
        "retry must not apply twice",
      );
    }
    if (realEgress) {
      assert.equal(
        streamResponse.headers.get("x-egress-id"),
        "flowgate.policy",
      );
      assert.equal(
        Number(streamResponse.headers.get("x-config-revision")),
        after.configuration.revision,
      );
      assert.equal(realEgress.metrics.proxyRequests, 1);
      assert.equal(realEgress.metrics.upstreamRequests, 1);
      const url = `http://127.0.0.1:${gatewayAfter.port}/v1/mock`;
      const init = {
        method: "POST",
        headers: { authorization: "Bearer internal-update-fixture" },
      };
      const cancellation = await fetch(url, init);
      const reader = cancellation.body.getReader();
      await reader.read();
      await reader.cancel();
      for (let i = 0; i < 100 && realEgress.metrics.upstreamAborts === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        realEgress.metrics.upstreamAborts,
        1,
        "client cancel must close the selected upstream path",
      );
      const beforeFailure = realEgress.metrics.upstreamRequests;
      realEgress.metrics.online = false;
      const failed = await fetch(url, init);
      assert.equal(failed.status, 502);
      await failed.text();
      assert.equal(
        realEgress.metrics.upstreamRequests,
        beforeFailure,
        "failed selected proxy must not fall back directly",
      );
    }
    results.push({
      variant,
      passed: true,
      ...(realEgress ? { egress: realEgress.metrics } : {}),
    });
    await page.evaluate(() =>
      window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
    );
    if (variant === "delayed-service") {
      await app.close();
      app = await electron.launch(launchOptions);
      page = await app.firstWindow();
      await page
        .getByRole("heading", { name: "概览" })
        .waitFor({ timeout: 20000 });
      const restarted = await page.evaluate(() =>
        window.shell.request("release.status"),
      );
      assert.equal(restarted.current, null);
      assert.ok(restarted.quarantine.includes(id));
      await assert.rejects(
        page.evaluate(
          (id) => window.shell.request("release.activate", { id }),
          id,
        ),
      );
    }
  } finally {
    await app.close();
    await new Promise((r) => server.close(r));
    await realEgress?.close();
  }
}
await writeFile(
  "work/update-result.json",
  JSON.stringify(
    { passed: true, at: new Date().toISOString(), results },
    null,
    2,
  ),
);
console.log(
  "PASS: real Electron signed UI/service update and failed-service rollback",
);
