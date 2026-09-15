import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import {
  independentTUNConfiguration,
  productionFullTUNConfiguration,
} from "./fixtures/independent-tun";
import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { NativeSession } from "../packages/shell/src/native-session";
import {
  compileConfiguration,
  initialConfiguration,
} from "../packages/domain/src/configuration";

// Never run privileged acceptance on a developer's current machine by default.
assert.equal(
  process.env.FLOWGATE_PRIVILEGED_CI,
  "1",
  "Explicit isolated CI opt-in required",
);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "GitHub Actions runner required",
);
assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  "github-hosted",
  "Ephemeral GitHub-hosted runner required",
);
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.ok(
  process.getuid!() >= 501,
  "Launch the client as the regular runner user",
);
assert.ok(
  process.env.FLOWGATE_PACKAGE_DIR,
  "Select the verified packaged candidate",
);
const exec = promisify(execFile);
const root = resolve("work/privileged-ci");
const nativeDirectory = join(
  resolve(process.env.FLOWGATE_PACKAGE_DIR!),
  "Contents/Resources/app/dist",
);
const installer = join(nativeDirectory, "flowgate-local-installer");
const tools = "/Library/PrivilegedHelperTools/com.flowgate.local";
const plist = "/Library/LaunchDaemons/com.flowgate.local.helper.plist";
const data = "/Library/Application Support/FlowGateLocal";
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
for (const path of [tools, plist, data])
  assert.equal(
    await exists(path),
    false,
    "Never replace an existing helper installation",
  );
await exec("/usr/bin/sudo", ["-n", "/usr/bin/true"]);
await mkdir(root, { recursive: true });
const privileged = (command: string, args: string[]) =>
  exec("/usr/bin/sudo", ["-n", command, ...args], { timeout: 30000 });
const observe = async () => ({
  proxy: (await exec("/usr/sbin/scutil", ["--proxy"])).stdout,
  dns: (await exec("/usr/sbin/scutil", ["--dns"])).stdout,
  route: (await exec("/sbin/route", ["-n", "get", "default"])).stdout,
});
const before = await observe();
assert.ok(
  !/HTTPEnable : 1|HTTPSEnable : 1|SOCKSEnable : 1|ProxyAutoConfigEnable : 1/.test(
    before.proxy,
  ),
  "Preserve any existing proxy configuration",
);
const result: any = {
  at: new Date().toISOString(),
  commit: JSON.parse(
    await readFile(join(nativeDirectory, "build-manifest.json"), "utf8"),
  ).commit,
  scope:
    "real local installer/XPC/root helper; system proxy and scoped TUN; kernel/helper SIGKILL; independent scoped TUN coexistence production full TUN and foreign system proxy mutation on an ephemeral macOS runner",
  checks: [],
};
const sockets = new Set<Socket>();
let forwarded = 0;
let peerForwarded = 0;
const origin = createServer((_req, response) =>
  response.end("flowgate-privileged-origin"),
);
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
const originPort = (origin.address() as any).port;
const proxy = createServer();
proxy.on("connect", (request, socket, head) => {
  if (request.url !== `198.18.0.88:${originPort}`) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  forwarded++;
  const remote = connect(originPort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) remote.write(head);
    socket.pipe(remote);
    remote.pipe(socket);
  });
  for (const stream of [socket as Socket, remote]) {
    sockets.add(stream);
    stream.on("close", () => sockets.delete(stream));
  }
  socket.on("error", () => remote.destroy());
  remote.on("error", () => socket.destroy());
  socket.on("close", () => remote.destroy());
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
// A separate endpoint rejects FlowGate's target, so success proves path selection.
const peerProxy = createServer((request, response) => {
  if (
    request.method !== "GET" ||
    request.url !== `http://198.18.0.89:${originPort}/`
  ) {
    response.writeHead(403);
    response.end();
    return;
  }
  peerForwarded++;
  const upstream = httpRequest(
    { hostname: "127.0.0.1", port: originPort, path: "/", method: "GET" },
    (remote) => {
      response.writeHead(remote.statusCode ?? 502, remote.headers);
      remote.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  response.on("close", () => upstream.destroy());
  upstream.end();
});
peerProxy.on("connect", (request, socket, head) => {
  if (request.url !== `198.18.0.89:${originPort}`) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  peerForwarded++;
  const remote = connect(originPort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) remote.write(head);
    socket.pipe(remote);
    remote.pipe(socket);
  });
  for (const stream of [socket as Socket, remote]) {
    sockets.add(stream);
    stream.on("close", () => sockets.delete(stream));
  }
  socket.on("error", () => remote.destroy());
  remote.on("error", () => socket.destroy());
  socket.on("close", () => remote.destroy());
});
await new Promise<void>((r) => peerProxy.listen(0, "127.0.0.1", r));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(150);
  }
  throw new Error(label);
}
async function alive(pid: number) {
  try {
    const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "pid="]);
    return stdout.trim() === String(pid);
  } catch (error: any) {
    if (error.code === 1) return false;
    throw error;
  }
}
async function helperPID() {
  const { stdout } = await privileged("/bin/launchctl", [
    "print",
    "system/com.flowgate.local.helper",
  ]);
  const match = stdout.match(/\bpid = (\d+)/);
  assert.ok(match, "Installed helper must be running");
  return Number(match[1]);
}
const peerConfiguration = join(root, "independent-peer.json");
const kernelPath = join(nativeDirectory, "sing-box");
let peer: ChildProcess | undefined;
let peerLog = "";
async function peerPID() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,command="]);
  const expected = `${kernelPath} run -c ${peerConfiguration}`;
  const matches = stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => match?.[2] === expected);
  assert.ok(matches.length <= 1, "Only one owned peer kernel may exist");
  return matches[0] ? Number(matches[0][1]) : undefined;
}
async function stopPeer() {
  // Resolve identity immediately before signalling; never use a stale saved PID.
  const pid = await peerPID();
  if (pid) await privileged("/bin/kill", ["-TERM", String(pid)]);
  await wait(async () => !(await peerPID()), "Independent peer did not exit");
  if (peer && peer.exitCode === null && peer.signalCode === null)
    await wait(
      async () => peer!.exitCode !== null || peer!.signalCode !== null,
      "Peer supervisor did not exit",
    );
  peer = undefined;
}
async function packet(address: string) {
  const { stdout } = await exec(
    "/usr/bin/curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--max-time",
      "8",
      "--noproxy",
      "*",
      `http://${address}:${originPort}/`,
    ],
    { timeout: 10000 },
  );
  assert.equal(stdout, "flowgate-privileged-origin");
}
async function routeInterface(address: string) {
  const { stdout } = await exec("/sbin/route", ["-n", "get", address]);
  return stdout.match(/interface: (\S+)/)?.[1];
}
async function startPeer() {
  assert.equal(await peerPID(), undefined);
  const interfaces = new Set(
    (await exec("/sbin/ifconfig", ["-l"])).stdout.trim().split(/\s+/),
  );
  const interfaceName = Array.from(
    { length: 100 },
    (_, index) => `utun${900 + index}`,
  ).find((name) => !interfaces.has(name));
  assert.ok(interfaceName, "No unused independent peer interface");
  await writeFile(
    peerConfiguration,
    JSON.stringify(
      independentTUNConfiguration(
        (peerProxy.address() as any).port,
        interfaceName,
      ),
    ),
  );
  await exec(kernelPath, ["check", "-c", peerConfiguration]);
  peer = spawn(
    "/usr/bin/sudo",
    ["-n", kernelPath, "run", "-c", peerConfiguration],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let launchError: Error | undefined;
  peer.on("error", (error) => {
    launchError = error;
  });
  for (const stream of [peer.stdout, peer.stderr])
    stream?.on("data", (data) => {
      peerLog = (peerLog + data.toString()).slice(-64000);
    });
  await wait(async () => {
    if (launchError) throw launchError;
    if (peer!.exitCode !== null || peer!.signalCode !== null)
      throw Error(
        "Independent peer exited before readiness: " + peerLog.slice(-1200),
      );
    if (!(await peerPID())) return false;
    return (await routeInterface("198.18.0.89"))?.startsWith("utun") ?? false;
  }, "Independent peer TUN did not become ready");
  await packet("198.18.0.89");
}
let native: NativeSession | undefined;
let attemptedInstallation = false;
let foreignSettingsActive = false;
const foreignSnapshot = join(root, "foreign-proxies.plist");
const foreignWriter = (mode: string, port?: number) =>
  privileged("/usr/bin/env", [
    "FLOWGATE_PRIVILEGED_CI=1",
    "GITHUB_ACTIONS=true",
    "RUNNER_ENVIRONMENT=github-hosted",
    join(root, "foreign-proxy-writer"),
    mode,
    foreignSnapshot,
    ...(port ? [String(port)] : []),
  ]);
try {
  await exec("/usr/bin/swiftc", [
    "-parse-as-library",
    "tests/SystemHTTPProbe.swift",
    "-o",
    join(root, "http-probe"),
  ]);
  await exec("/usr/bin/swiftc", [
    "-parse-as-library",
    "tests/ForeignProxyWriter.swift",
    "-o",
    join(root, "foreign-proxy-writer"),
  ]);
  const hashes = await Promise.all(
    ["flowgate-bridge", "flowgate-helper", "sing-box"].map(async (name) =>
      createHash("sha256")
        .update(await readFile(join(nativeDirectory, name)))
        .digest("hex"),
    ),
  );
  attemptedInstallation = true;
  await privileged(installer, [
    "install",
    nativeDirectory,
    String(process.getuid!()),
    ...hashes,
  ]);
  result.checks.push({ installation: "production local installer completed" });
  for (const mode of ["system", "tun"] as const)
    for (const fault of ["none", "kernel", "helper"] as const) {
      const scenario = `${mode}-${fault}`;
      native = new NativeSession(
        join(nativeDirectory, "flowgate-bridge"),
        join(nativeDirectory, "sing-box"),
        join(root, scenario),
        true,
      );
      await native.start();
      await wait(async () => {
        const state = await native!.status();
        return state.systemControl && state.status === "stopped";
      }, "Privileged helper not ready");
      const configuration = initialConfiguration();
      configuration.settings.mode = mode;
      configuration.nodes = [
        {
          id: "fixture",
          name: "Controlled local outlet",
          type: "http",
          server: "127.0.0.1",
          port: (proxy.address() as any).port,
          options: {},
        },
      ];
      configuration.settings.selectedNode = "fixture";
      const compiled: any = compileConfiguration(configuration);
      if (mode === "tun") {
        compiled.inbounds[0].route_address = ["198.18.0.88/32"];
        compiled.outbounds.find(
          (outbound: any) => outbound.tag === "fixture",
        ).bind_interface = "lo0";
      }
      const countBefore = forwarded;
      const state = await native.apply(compiled, 1, scenario, mode);
      assert.equal(state.status, "running");
      assert.equal(state.systemControl, true);
      assert.ok(state.pid);
      const target = `http://198.18.0.88:${originPort}/`;
      if (mode === "system") {
        assert.equal(state.systemProxyOwned, true);
        await exec(join(root, "http-probe"), [target], { timeout: 20000 });
      } else {
        const { stdout } = await exec(
          "/usr/bin/curl",
          [
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "12",
            "--noproxy",
            "*",
            target,
          ],
          { timeout: 15000 },
        );
        assert.equal(stdout, "flowgate-privileged-origin");
      }
      assert.ok(
        forwarded > countBefore,
        "Packet must traverse the controlled outlet",
      );
      if (fault === "none") await native.stop(`stop-${scenario}`);
      else if (fault === "kernel")
        await privileged("/bin/kill", ["-KILL", String(state.pid)]);
      else await privileged("/bin/kill", ["-KILL", String(await helperPID())]);
      // Do not call helper status here: a new XPC request could restart the helper
      // and mask failure of the independent watchdog after a real helper crash.
      await wait(
        async () =>
          !(await alive(state.pid!)) &&
          (await observe()).proxy === before.proxy,
        `${scenario}: kernel/proxy recovery failed`,
      );
      if (state.tunInterface)
        assert.ok(
          !(await exec("/sbin/ifconfig", ["-l"])).stdout
            .trim()
            .split(/\s+/)
            .includes(state.tunInterface),
          "Owned TUN interface must disappear",
        );
      assert.deepEqual(
        await observe(),
        before,
        `${scenario}: global state changed`,
      );
      result.checks.push({
        scenario,
        actualForwarding: true,
        kernelExited: true,
        settingsRestored: true,
      });
      await native.close().catch((error) => {
        if (fault === "none") throw error;
      });
      native = undefined;
      await pause(300);
    }
  // Coexistence at the native/helper boundary, not a simulated observation and
  // not an assertion about the Service's full VPN-change coordination policy.
  await startPeer();
  const peerInterface = await routeInterface("198.18.0.89");
  native = new NativeSession(
    join(nativeDirectory, "flowgate-bridge"),
    kernelPath,
    join(root, "two-tun"),
    true,
  );
  await native.start();
  await wait(async () => {
    const state = await native!.status();
    return state.systemControl && state.status === "stopped";
  }, "Coexisting helper not ready");
  const configuration = initialConfiguration();
  configuration.settings.mode = "tun";
  configuration.nodes = [
    {
      id: "fixture",
      name: "FlowGate outlet",
      type: "http",
      server: "127.0.0.1",
      port: (proxy.address() as any).port,
      options: {},
    },
  ];
  configuration.settings.selectedNode = "fixture";
  const compiled: any = compileConfiguration(configuration);
  compiled.inbounds[0].route_address = ["198.18.0.88/32"];
  compiled.outbounds.find(
    (entry: any) => entry.tag === "fixture",
  ).bind_interface = "lo0";
  let generation = 0;
  const startFlowGate = async () => {
    const state = await native!.apply(
      compiled,
      ++generation,
      `two-tun-${generation}`,
      "tun",
    );
    assert.equal(state.status, "running");
    assert.equal(state.systemControl, true);
    assert.ok(state.pid);
    assert.ok(state.tunInterface);
    return state;
  };
  const checkBoth = async () => {
    const ownCount = forwarded,
      peerCount = peerForwarded;
    await packet("198.18.0.88");
    await packet("198.18.0.89");
    assert.ok(
      forwarded > ownCount && peerForwarded > peerCount,
      "Each target must reach its distinct controlled outlet",
    );
    assert.notEqual(
      await routeInterface("198.18.0.88"),
      await routeInterface("198.18.0.89"),
    );
    assert.deepEqual(
      await observe(),
      before,
      "Scoped peers must preserve default route/proxy/DNS",
    );
  };
  let own = await startFlowGate();
  await checkBoth();
  assert.notEqual(own.tunInterface, peerInterface);
  // A rejected replacement must fail before unloading the working installation.
  const helperBeforeRejectedInstall = await helperPID();
  await assert.rejects(
    privileged(installer, [
      "install",
      nativeDirectory,
      String(process.getuid!()),
      "0".repeat(64),
      ...hashes.slice(1),
    ]),
    (error: any) => /授权期间程序发生变化/.test(String(error.stderr)),
  );
  assert.equal(await helperPID(), helperBeforeRejectedInstall);
  assert.equal((await native.status()).pid, own.pid);
  await checkBoth();
  result.checks.push({
    scenario: "rejected-replacement",
    oldHelperPreserved: true,
    oldKernelPreserved: true,
    distinctOutlets: true,
  });
  await native.stop("two-tun-stop-own");
  await wait(
    async () => !(await alive(own.pid!)),
    "FlowGate kernel did not stop",
  );
  assert.notEqual(
    await routeInterface("198.18.0.88"),
    own.tunInterface,
    "Stopped FlowGate route must disappear",
  );
  await packet("198.18.0.89");
  assert.equal(await routeInterface("198.18.0.89"), peerInterface);
  result.checks.push({
    scenario: "two-tun-own-stop",
    distinctOutlets: true,
    peerSurvived: true,
  });
  own = await startFlowGate();
  await checkBoth();
  await stopPeer();
  assert.notEqual(
    await routeInterface("198.18.0.89"),
    peerInterface,
    "Stopped peer route must disappear",
  );
  await packet("198.18.0.88");
  assert.equal((await native.status()).pid, own.pid);
  await startPeer();
  await checkBoth();
  result.checks.push({
    scenario: "two-tun-peer-restart",
    distinctOutlets: true,
    ownSurvived: true,
  });
  await privileged("/bin/kill", ["-KILL", String(await helperPID())]);
  // Observe independent recovery before issuing any new XPC request.
  await wait(
    async () => !(await alive(own.pid!)),
    "Helper crash left its kernel alive",
  );
  await packet("198.18.0.89");
  assert.ok(
    await peerPID(),
    "FlowGate recovery must not kill the independent peer",
  );
  assert.deepEqual(await observe(), before);
  result.checks.push({
    scenario: "two-tun-helper-crash",
    ownExited: true,
    peerSurvived: true,
  });
  await native.close().catch(() => {});
  native = undefined;
  await stopPeer();
  await privileged(installer, [
    "install",
    nativeDirectory,
    String(process.getuid!()),
    ...hashes,
  ]);
  native = new NativeSession(
    join(nativeDirectory, "flowgate-bridge"),
    kernelPath,
    join(root, "reinstalled"),
    true,
  );
  await native.start();
  await wait(async () => {
    const state = await native!.status();
    return state.systemControl && state.status === "stopped";
  }, "Reinstalled helper not ready");
  const reinstalled = await native.apply(compiled, 1, "reinstalled", "tun");
  assert.equal(reinstalled.status, "running");
  assert.equal(reinstalled.systemControl, true);
  const countBeforeReinstallProbe = forwarded;
  await packet("198.18.0.88");
  assert.ok(forwarded > countBeforeReinstallProbe);
  await native.stop("stop-reinstalled");
  await native.close();
  native = undefined;
  assert.deepEqual(await observe(), before);
  result.checks.push({
    scenario: "same-version-reinstall",
    xpcReady: true,
    actualForwarding: true,
    settingsRestored: true,
  });
  for (const fault of ["none", "helper"] as const) {
    result.phase = `foreign-proxy-${fault}`;
    await foreignWriter("capture");
    foreignSettingsActive = true;
    native = new NativeSession(
      join(nativeDirectory, "flowgate-bridge"),
      kernelPath,
      join(root, `foreign-proxy-${fault}`),
      true,
    );
    await native.start();
    await wait(async () => {
      const state = await native!.status();
      return state.systemControl && state.status === "stopped";
    }, "Foreign proxy scenario helper not ready");
    const ownConfiguration = initialConfiguration();
    ownConfiguration.settings.mode = "system";
    ownConfiguration.settings.selectedNode = "fixture";
    ownConfiguration.nodes = [
      {
        id: "fixture",
        name: "Own outlet",
        type: "http",
        server: "127.0.0.1",
        port: (proxy.address() as any).port,
        options: {},
      },
    ];
    const ownState = await native.apply(
      compileConfiguration(ownConfiguration),
      1,
      `foreign-${fault}`,
      "system",
    );
    assert.equal(ownState.status, "running");
    assert.ok(ownState.pid);
    await exec(
      join(root, "http-probe"),
      [`http://198.18.0.88:${originPort}/`],
      { timeout: 20000 },
    );
    const foreignPort = (peerProxy.address() as any).port;
    await foreignWriter("takeover", foreignPort);
    await wait(
      async () => (await observe()).proxy.includes(`HTTPPort : ${foreignPort}`),
      "Independent HTTP proxy did not become effective",
    );
    if (fault === "none") await native.stop("stop-foreign-proxy");
    else await privileged("/bin/kill", ["-KILL", String(await helperPID())]);
    // No XPC call before checking the independent watchdog's outcome.
    await wait(async () => {
      if (await alive(ownState.pid!)) return false;
      try {
        await foreignWriter("verify", foreignPort);
        return true;
      } catch {
        return false;
      }
    }, "Recovery did not preserve foreign HTTP and restore only owned groups");
    const requestsBefore = peerForwarded;
    await exec(
      join(root, "http-probe"),
      [`http://198.18.0.89:${originPort}/`],
      { timeout: 20000 },
    );
    assert.ok(
      peerForwarded > requestsBefore,
      "macOS must still use the independent HTTP proxy",
    );
    await native.close().catch((error) => {
      if (fault === "none") throw error;
    });
    native = undefined;
    await foreignWriter("restore");
    foreignSettingsActive = false;
    await wait(
      async () => JSON.stringify(await observe()) === JSON.stringify(before),
      "Foreign fixture cleanup failed",
    );
    result.checks.push({
      scenario: `foreign-system-proxy-${fault}`,
      actualForwarding: true,
      foreignHTTPPreserved: true,
      ownedHTTPSAndSOCKSRestored: true,
      kernelExited: true,
      settingsRestored: true,
    });
  }
  // Use production full-TUN output unchanged: no route_address narrowing and
  // no fixture-only lo0 binding. Default direct keeps this disposable runner's
  // ordinary traffic usable; only the dedicated target selects the local proxy.
  const internet = async () => {
    await exec(
      "/usr/bin/curl",
      [
        "-4",
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "20",
        "--noproxy",
        "*",
        "--output",
        "/dev/null",
        "https://example.com/",
      ],
      { timeout: 22000 },
    );
  };
  result.phase = "full-tun-public-baseline";
  await internet();
  await startPeer();
  const fullCompiled = productionFullTUNConfiguration(
    (proxy.address() as any).port,
  );
  native = new NativeSession(
    join(nativeDirectory, "flowgate-bridge"),
    kernelPath,
    join(root, "production-full-tun"),
    true,
  );
  await native.start();
  await wait(async () => {
    const state = await native!.status();
    return state.systemControl && state.status === "stopped";
  }, "Full TUN helper not ready");
  result.phase = "full-tun-start";
  const fullState = await native.apply(
    fullCompiled,
    1,
    "production-full-tun",
    "tun",
  );
  assert.equal(fullState.status, "running");
  assert.ok(fullState.tunInterface);
  assert.ok(fullState.pid);
  assert.equal(await routeInterface("198.18.0.88"), fullState.tunInterface);
  result.phase = "full-tun-local-outlets";
  const fullOwnCount = forwarded,
    fullPeerCount = peerForwarded;
  await packet("198.18.0.88");
  await packet("198.18.0.89");
  assert.ok(
    forwarded > fullOwnCount && peerForwarded > fullPeerCount,
    "Production full TUN and independent peer must use their respective outlets",
  );
  assert.notEqual(await routeInterface("198.18.0.89"), fullState.tunInterface);
  result.phase = "full-tun-public-https";
  const resolved = await lookup("example.com", { family: 4 });
  assert.equal(
    await routeInterface(resolved.address),
    fullState.tunInterface,
    "Ordinary IPv4 traffic must actually enter the full TUN",
  );
  await internet();
  result.phase = "full-tun-restoration";
  await native.stop("stop-production-full-tun");
  await wait(
    async () => !(await alive(fullState.pid!)),
    "Full TUN kernel did not stop",
  );
  await packet("198.18.0.89");
  await native.close();
  native = undefined;
  await stopPeer();
  await wait(
    async () => JSON.stringify(await observe()) === JSON.stringify(before),
    "Full TUN network settings did not recover",
  );
  await internet();
  result.checks.push({
    scenario: "production-full-tun-local-http",
    unmodifiedCompiledConfiguration: true,
    actualForwarding: true,
    distinctOutlets: true,
    publicIPv4HTTPS: true,
    peerSurvived: true,
    settingsRestored: true,
  });
  result.phase = "complete";
  result.passed = true;
} catch (error: any) {
  result.error = String(error.message).slice(0, 1600);
  result.passed = false;
} finally {
  try {
    await native?.close();
  } catch {}
  try {
    await stopPeer();
  } catch (error: any) {
    result.peerCleanupError = String(error.message);
    result.passed = false;
  }
  await writeFile(join(root, "independent-peer.log"), peerLog);
  if (attemptedInstallation) {
    try {
      await privileged(installer, ["uninstall"]);
      result.uninstalled = true;
      await privileged(installer, ["uninstall"]);
      result.repeatedUninstall = true;
    } catch (error: any) {
      result.cleanupError = String(error.message).slice(0, 1200);
      result.passed = false;
    }
  }
  if (foreignSettingsActive) {
    try {
      await foreignWriter("restore");
      foreignSettingsActive = false;
    } catch (error: any) {
      result.foreignCleanupError = String(error.message);
      result.passed = false;
    }
  }
  for (const socket of sockets) socket.destroy();
  peerProxy.closeAllConnections();
  proxy.closeAllConnections();
  origin.closeAllConnections();
  await Promise.all([
    new Promise((r) => peerProxy.close(r)),
    new Promise((r) => proxy.close(r)),
    new Promise((r) => origin.close(r)),
  ]);
  result.networkUnchanged =
    JSON.stringify(await observe()) === JSON.stringify(before);
  result.installationRemoved =
    !(await exists(tools)) && !(await exists(plist)) && !(await exists(data));
  if (!result.networkUnchanged || !result.installationRemoved)
    result.passed = false;
  await writeFile(
    "work/privileged-ci-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
