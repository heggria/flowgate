import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { tufHandlers } from "@tufjs/repo-mock";
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { mkdir, mkdtemp, cp, readFile, writeFile } from "node:fs/promises";
import { resolve, join, posix } from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixtureRepository } from "./tuf-fixture.mjs";
import { isolateProxyPort } from "./proxy-fixture.mjs";
import {
  verifyArtifacts,
  inventory as artifactInventory,
} from "../scripts/artifacts.mjs";
import { verifyDirectory } from "../packages/release/src/loader.ts";
import {
  captureSoakProcess,
  closeSoakApp,
  within,
} from "./fixtures/soak-cleanup.mjs";
import {
  waitForAsyncPredicate,
  isContextReplacementError,
} from "./async-poll.mjs";
const [preparedPath, buildPath] = process.argv.slice(2);
assert.ok(
  preparedPath && buildPath,
  "Usage: node --import tsx tests/business-candidate.integration.mjs <prepared-directory> <exact-build-directory>",
);
const prepared = resolve(preparedPath),
  build = resolve(buildPath);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const provenance = JSON.parse(
  await readFile(join(prepared, "provenance.json"), "utf8"),
);
assert.equal(provenance.published, false);
assert.equal(provenance.unsigned, true);
const inventory = await verifyArtifacts(build);
assert.equal(inventory.dirty, false);
assert.equal(inventory.commit, provenance.commit);
assert.equal(
  sha(await readFile(join(build, "build-manifest.json"))),
  provenance.buildManifestSHA256,
);
const manifestBytes = await readFile(join(prepared, "manifest.json"));
assert.equal(sha(manifestBytes), provenance.manifestSHA256);
assert.equal(
  sha(await readFile(join(prepared, "request/signing/targets.json"))),
  provenance.signingTargetsSHA256,
);
const sumFiles = new Map();
for (const line of (await readFile(join(prepared, "SHA256SUMS"), "utf8"))
  .trim()
  .split("\n")) {
  const match = line.match(/^([a-f0-9]{64})  ([\w./-]+)$/);
  assert.ok(match);
  assert.ok(!match[2].split("/").includes("..") && !match[2].startsWith("/"));
  assert.ok(
    !sumFiles.has(match[2]),
    "Checksum list must not duplicate entries",
  );
  sumFiles.set(match[2], match[1]);
  assert.equal(sha(await readFile(join(prepared, match[2]))), match[1]);
}
const preparedFiles = await artifactInventory(prepared);
delete preparedFiles.SHA256SUMS;
preparedFiles["build-manifest.json"] = {
  sha256: provenance.buildManifestSHA256,
};
assert.deepEqual(
  [...sumFiles.keys()].sort(),
  Object.keys(preparedFiles).sort(),
);
for (const [name, file] of Object.entries(preparedFiles))
  assert.equal(sumFiles.get(name), file.sha256);
const manifest = JSON.parse(manifestBytes);
await verifyDirectory(join(build, "release"), manifest);
const signingTargets = JSON.parse(
  await readFile(join(prepared, "request/signing/targets.json"), "utf8"),
);
assert.deepEqual(signingTargets.signatures, []);
async function preparedTarget(name) {
  assert.match(name, /^[\w./-]+$/);
  assert.ok(!name.split("/").includes("..") && !name.startsWith("/"));
  const target = signingTargets.signed.targets[name];
  assert.ok(target, `Prepared target missing: ${name}`);
  assert.match(target.hashes.sha256, /^[a-f0-9]{64}$/);
  const content = await readFile(
    join(
      prepared,
      "request/targets",
      posix.dirname(name),
      target.hashes.sha256 + "." + posix.basename(name),
    ),
  );
  assert.equal(content.length, target.length);
  assert.equal(sha(content), target.hashes.sha256);
  return { name, content };
}
const targets = await Promise.all(
  Object.keys(manifest.files).map(async (name) => {
    const target = await preparedTarget(manifest.id + "/" + name);
    assert.deepEqual(
      target.content,
      await readFile(join(build, "release", name)),
    );
    return target;
  }),
);
const channelTarget = await preparedTarget(manifest.channel + "/release.json");
assert.deepEqual(JSON.parse(channelTarget.content), manifest);
targets.push(channelTarget);
const repository = fixtureRepository(targets),
  handlers = tufHandlers(repository, {});
await mkdir("work", { recursive: true });
const work = await mkdtemp(resolve("work/business-candidate-"));
const fixture = join(work, "app"),
  data = join(work, "userdata");
await mkdir(fixture);
await cp(build, join(fixture, "dist"), { recursive: true });
await writeFile(
  join(fixture, "package.json"),
  JSON.stringify({
    name: "flowgate-business-candidate",
    main: "dist/main.cjs",
  }),
);
const cert = join(work, "server.crt"),
  key = join(work, "server.key"),
  configuration = join(work, "openssl.cnf");
await writeFile(
  configuration,
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
    configuration,
  ],
  { stdio: "ignore" },
);
const tls = httpsServer(
  { key: await readFile(key), cert: await readFile(cert) },
  (req, res) => {
    const handler = handlers.find((h) => h.path === req.url);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }
    const response = handler.fn();
    res
      .writeHead(response.statusCode, {
        "content-type": response.contentType ?? "application/json",
      })
      .end(response.response);
  },
);
const origin = httpServer((_req, res) =>
  res.end("exact-business-candidate-forwarding"),
);
await new Promise((r) => tls.listen(0, "127.0.0.1", r));
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const base = `https://localhost:${tls.address().port}`;
await writeFile(
  join(fixture, "dist/trusted-root.json"),
  JSON.stringify(repository.rootMeta.toJSON()),
);
await writeFile(
  join(fixture, "dist/update-config.json"),
  JSON.stringify({
    enabled: true,
    metadataUrl: base + "/metadata/",
    targetUrl: base + "/targets/",
    applicationFeed: "",
  }),
);
const exec = promisify(execFile);
const observe = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        ["proxy", "/usr/sbin/scutil", ["--proxy"]],
        ["dns", "/usr/sbin/scutil", ["--dns"]],
        ["route", "/sbin/route", ["-n", "get", "default"]],
      ].map(async ([name, command, args]) => [
        name,
        (await exec(command, args)).stdout,
      ]),
    ),
  );
const before = await observe();
await writeFile(
  join(work, "network-private.json"),
  JSON.stringify({ before }),
  { mode: 0o600 },
);
let app,
  owned,
  requests = 0;
const result = {
  passed: false,
  commit: provenance.commit,
  release: manifest.id,
  version: manifest.version,
  requestManifestSHA256: sha(channelTarget.content),
  testTrustOnly: true,
  officiallySigned: false,
  published: false,
  checks: [],
  cleanup: [],
};
const close = async () => {
  if (!app) return;
  const cleanup = await closeSoakApp(app, owned);
  result.cleanup.push(cleanup);
  app = undefined;
  owned = undefined;
  assert.equal(cleanup.processExited, true);
  assert.equal(cleanup.graceful, true);
};
const launch = async () => {
  app = await electron.launch({
    args: [fixture],
    ...(process.env.FLOWGATE_BUSINESS_ELECTRON
      ? { executablePath: resolve(process.env.FLOWGATE_BUSINESS_ELECTRON) }
      : {}),
    env: {
      ...process.env,
      FLOWGATE_TEST_DATA: data,
      FLOWGATE_TEST_VISIBLE: "0",
      NODE_EXTRA_CA_CERTS: cert,
    },
  });
  owned = await captureSoakProcess(
    app,
    data,
    await app.evaluate(() => process.execPath),
  );
  const pem = await readFile(cert, "utf8");
  await app.evaluate(
    ({ session }, pem) =>
      session.defaultSession.setCertificateVerifyProc(
        ({ hostname, certificate }, done) =>
          done(
            hostname === "localhost" &&
              certificate.data.replace(/\s/g, "") === pem.replace(/\s/g, "")
              ? 0
              : -3,
          ),
      ),
    pem,
  );
  const page = await app.firstWindow();
  await page
    .getByRole("heading", { name: "概览", exact: true })
    .waitFor({ timeout: 30000 });
  return page;
};
async function waitFor(predicate, timeout = 30000) {
  await waitForAsyncPredicate(predicate, {
    timeout,
    polling: 200,
    retryOnError: isContextReplacementError,
  });
}
const probe = async (page) => {
  await waitFor(async () => {
    const release = await page.evaluate(() =>
      window.shell.request("release.status"),
    );
    if (release.updating || release.suspended) return false;
    const snapshot = await page.evaluate(() =>
      window.flowgate.request("snapshot"),
    );
    return (
      snapshot.configuration.settings.mode === "manual" &&
      snapshot.kernel.status !== "starting"
    );
  });
  assert.equal(
    fileURLToPath(page.url()),
    join(data, "releases", manifest.id, manifest.ui),
  );
  const hidden = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().every(
      (w) => !w.isVisible() && !w.isFocusable() && !w.isFocused(),
    ),
  );
  assert.equal(hidden, true);
  result.stage = "reserve manual proxy port";
  const port = await isolateProxyPort(page);
  result.stage = "connect manual proxy";
  await page.evaluate(() =>
    window.flowgate.request("proxy.connect", {}, crypto.randomUUID()),
  );
  const state = await page.evaluate(() => window.flowgate.request("snapshot"));
  assert.equal(state.configuration.settings.mode, "manual");
  assert.equal(state.kernel.systemControl, false);
  for (const scheme of ["http", "socks5h"]) {
    const { stdout } = await exec("/usr/bin/curl", [
      "--fail",
      "--silent",
      "--max-time",
      "15",
      "--noproxy",
      "",
      "--proxy",
      `${scheme}://127.0.0.1:${port}`,
      `http://127.0.0.1:${origin.address().port}/`,
    ]);
    assert.equal(stdout, "exact-business-candidate-forwarding");
    requests++;
  }
  await page.evaluate(() =>
    window.flowgate.request("proxy.disconnect", {}, crypto.randomUUID()),
  );
};
try {
  result.stage = "initial launch";
  let page = await launch();
  result.stage = "download verified candidate";
  const candidate = await page.evaluate(
    (channel) => window.shell.request("release.check", { channel }),
    manifest.channel,
  );
  assert.equal(candidate.id, manifest.id);
  assert.equal(candidate.version, manifest.version);
  for (const [name, file] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(data, "releases", manifest.id, name));
    assert.equal(sha(bytes), file.sha256);
  }
  const activation = page.evaluate(
    (id) => window.shell.request("release.activate", { id }),
    manifest.id,
  );
  activation.catch(() => {});
  await waitFor(async () => {
    const state = await page.evaluate(() =>
      window.shell.request("release.status"),
    );
    return !state.updating && state.current === manifest.id;
  });
  result.stage = "forward after activation";
  await probe(page);
  result.checks.push(
    "prepared digest artifacts downloaded and activated; downloaded UI path verified",
    "hidden manual HTTP and SOCKS forwarding",
  );
  await close();
  result.stage = "restart candidate";
  page = await launch();
  assert.equal(
    (await page.evaluate(() => window.shell.request("release.status"))).current,
    manifest.id,
  );
  result.stage = "forward after activation";
  await probe(page);
  result.checks.push(
    "verified candidate survives restart and forwards HTTP/SOCKS",
  );
  await close();
  result.passed = true;
} catch (error) {
  result.error = String(error.message).slice(0, 1000);
  try {
    result.shellStatus = await within(
      app.firstWindow().then((page) =>
        page.evaluate(async () => {
          const state = await window.shell.request("release.status");
          return {
            current: state.current,
            updating: state.updating,
            suspended: state.suspended,
          };
        }),
      ),
      2000,
    );
  } catch {}
} finally {
  try {
    await close();
  } catch (error) {
    result.passed = false;
    result.cleanupError = String(error.message).slice(0, 300);
  }
  tls.closeAllConnections();
  origin.closeAllConnections();
  await Promise.all([
    new Promise((r) => tls.close(r)),
    new Promise((r) => origin.close(r)),
  ]);
  const after = await observe();
  await writeFile(
    join(work, "network-private.json"),
    JSON.stringify({ before, after }),
    { mode: 0o600 },
  );
  result.networkChangedFields = Object.keys(before).filter(
    (name) => before[name] !== after[name],
  );
  result.networkUnchanged = result.networkChangedFields.length === 0;
  if (!result.networkUnchanged) result.passed = false;
  result.requests = requests;
  result.at = new Date().toISOString();
  const output = resolve(
    process.env.FLOWGATE_BUSINESS_CANDIDATE_RESULT ??
      "work/business-candidate-result.json",
  );
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: result.passed,
      commit: result.commit,
      release: result.release,
      requests,
      result: output,
      error: result.error,
    }),
  );
  if (!result.passed) process.exitCode = 1;
}
