// Presentation fixtures only: no network, Service, helper or actual forwarding.
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
export async function createUISurface() {
  const directory = await mkdtemp(resolve("work/ui-surface-"));
  await mkdir(directory, { recursive: true });
  for (const file of ["app.js", "style.css", "index.html"])
    await copyFile(resolve("dist/release", file), join(directory, file));
  const catalog = JSON.parse(
    await readFile("packages/contracts/src/builtin-catalog.json", "utf8"),
  );
  const now = new Date().toISOString(),
    longDomain = ("abcdefghij".repeat(6) + ".").repeat(3) + "example.com";
  const snapshot = {
    protocol: 1,
    epoch: 1,
    releaseSet: "ui-fixture",
    lifecycle: "ready",
    modules: [],
    extensionRevision: 1,
    configuration: {
      schema: 1,
      revision: 2,
      nodes: [
        {
          id: "node-one",
          name: "主线路 · Tokyo",
          type: "socks",
          server: "127.0.0.1",
          port: 24001,
        },
        {
          id: "node-two",
          name: "长名称".repeat(60),
          type: "http",
          server: longDomain,
          port: 443,
        },
      ],
      subscriptions: [
        {
          id: "source-one",
          name: "工作订阅",
          nodeIds: ["node-one"],
          updatedAt: now,
          error: "测试：订阅暂时不可用，已保留上次结果。",
        },
      ],
      rules: [
        {
          id: "rule-one",
          kind: "domain_suffix",
          value: longDomain,
          outbound: "node-one",
        },
      ],
      ruleSources: [
        {
          id: "rules-one",
          name: "工作规则集",
          url: "https://example.com/rules",
          format: "domain-list",
          outbound: "direct",
          count: 12,
          error: "测试：规则集更新失败，已保留上次结果。",
        },
      ],
      externalNetworks: [
        {
          id: "network-one",
          name: "工作网络",
          interface: "en0",
          dnsServer: "https://" + longDomain + "/dns-query",
        },
      ],
      settings: {
        mode: "manual",
        listenPort: 17890,
        selectedNode: "node-one",
        finalOutbound: "select",
        dnsServer: "https://1.1.1.1/dns-query",
        autoConnect: false,
      },
    },
    kernel: { status: "running", appliedRevision: 1, systemControl: false },
    operations: ["pending", "succeeded", "failed", "unknown"].map(
      (state, i) => ({
        id: "operation-" + i,
        traceId: "trace-" + i,
        kind: "configuration.save",
        state,
        revision: i,
        startedAt: now,
        message:
          state === "failed"
            ? "测试：配置未能应用，请检查输入后重试。"
            : undefined,
      }),
    ),
    network: {
      capturedAt: now,
      defaultInterface: "en0",
      defaultGateway: "192.0.2.1",
      proxyEnabled: false,
      interfaces: [
        { name: "en0", addresses: ["192.0.2.10", "2001:db8::10"] },
        { name: "utun12", addresses: ["2001:db8:1::10"] },
      ],
      dns: [],
      routes: [],
      warnings: [],
      plugins: [],
      systemProxies: [{ kind: "socks", host: "192.0.2.20", port: 1080 }],
      pacEnabled: true,
    },
    networkConflicts: [
      {
        id: "warning-one",
        severity: "warning",
        message: "测试：观察到其他代理设置，继续使用当前手动代理。",
      },
      {
        id: "blocked-one",
        severity: "blocked",
        message: "测试：外部接口暂时不可用。",
      },
    ],
    traffic: {
      available: true,
      upload: 124000,
      download: 456000,
      uploadRate: 5000,
      downloadRate: 9000,
      activeConnections: 1,
      history: Array.from({ length: 30 }, (_, i) => ({
        at: Date.now() - (29 - i) * 1000,
        uploadRate: 3000 + i * 100,
        downloadRate: 9000 - i * 90,
      })),
      flows: [
        {
          id: "flow-one",
          target: longDomain,
          protocol: "tcp",
          outbound: "node-one",
          rule: "rule-one",
          upload: 124000,
          download: 456000,
          state: "active",
        },
      ],
    },
    nodeMeasurements: [
      { id: "node-one", state: "running" },
      { id: "node-two", state: "failed", message: "测试：延迟测量失败。" },
    ],
    extensions: catalog.map((entry, i) => ({
      ...entry,
      enabled: i !== 4,
      desiredEnabled: i !== 4,
      status:
        i === 0
          ? "failed"
          : i === 1
            ? "starting"
            : i === 3
              ? "unavailable"
              : i === 4
                ? "stopped"
                : "ready",
      error: i === 0 ? "测试：扩展发生异常，任务已停止。" : undefined,
      instance: entry.id + ":fixture",
      releaseSet: "ui-fixture",
    })),
  };
  const script = `const initial=${JSON.stringify(snapshot)},catalog=${JSON.stringify(catalog)};
 (${function (initial, catalog) {
   const listeners = new Set(),
     drafts = new Map(),
     holds = [],
     loaders = [];
   const fixture = (window.uiFixture = {
     snapshot: initial,
     catalog,
     loading: new URL(location.href).searchParams.has("loading"),
     outcomes: {},
     calls: {},
     release: {
       release: "fixture-release-" + "long-version-".repeat(7),
       configured: true,
       channel: "stable",
       versions: { shell: "0.2.0", service: "0.2.0" },
       events: [
         {
           stage: "failed",
           at: new Date().toISOString(),
           releaseSet: "previous",
         },
       ],
     },
     gateway: { available: true, lifecycle: "stopped" },
     candidate: {
       id: "fixture-candidate-1",
       channel: "stable",
       releaseNotes: "测试发布说明，用于界面验证。",
       builtins: catalog.map((e) => ({ id: e.id, version: "1.0.1" })),
     },
     push(next) {
       this.snapshot = structuredClone(next);
       for (const listener of listeners) listener(this.snapshot);
     },
     releaseLoading() {
       this.loading = false;
       for (const resolve of loaders.splice(0)) resolve(this.snapshot);
     },
     finish(method, error) {
       for (const h of holds.filter((h) => h.method === method)) {
         holds.splice(holds.indexOf(h), 1);
         if (error) h.reject(Error(error));
         else h.resolve();
       }
     },
   });
   async function request(method, payload, operationId) {
     fixture.calls[method] = (fixture.calls[method] ?? 0) + 1;
     if (method === "snapshot") {
       if (fixture.loading) return new Promise((r) => loaders.push(r));
       return structuredClone(fixture.snapshot);
     }
     if (method === "ui.draft.get") return drafts.get(payload?.key ?? "legacy");
     if (method === "ui.draft.set") {
       drafts.set(payload?.key ?? "legacy", payload?.value ?? payload);
       return;
     }
     if (method === "ui.ready") return;
     const outcome = fixture.outcomes[method];
     if (outcome === "hold")
       await new Promise((resolve, reject) =>
         holds.push({ method, operationId, resolve, reject }),
       );
     else if (outcome) throw Error(outcome);
     if (method === "release.status") return fixture.release;
     if (method === "release.check") return fixture.candidate;
     if (method === "gateway.status") return fixture.gateway;
     if (method === "diagnostics.trace")
       return [
         {
           time: new Date().toISOString(),
           name: "service.request",
           status: "failed",
           context: { traceId: "fixture-trace", version: "1" },
         },
       ];
     if (method === "policy.explain") return { outbound: "direct" };
     if (method === "configuration.save") {
       fixture.push({ ...fixture.snapshot, configuration: payload });
       return { snapshot: fixture.snapshot };
     }
     return { snapshot: fixture.snapshot };
   }
   window.flowgate = {
     request,
     subscribe(listener) {
       listeners.add(listener);
       return () => listeners.delete(listener);
     },
     async cancel(id) {
       for (const hold of holds.filter((h) => h.operationId === id)) {
         holds.splice(holds.indexOf(hold), 1);
         hold.reject(Error("测试：请求已取消。"));
       }
       return { requested: true };
     },
   };
   window.shell = {
     version: "0.2.0",
     platform: "darwin",
     request,
     onNavigate() {
       return () => {};
     },
   };
 }.toString()})(initial,catalog);`;
  await writeFile(join(directory, "fixture.js"), script);
  const html = await readFile(join(directory, "index.html"), "utf8");
  await writeFile(
    join(directory, "index.html"),
    html.replace(
      '<script src="app.js">',
      '<script src="fixture.js"></script><script src="app.js">',
    ),
  );
  const main = join(directory, "main.cjs");
  await writeFile(
    main,
    `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,focusable:false,skipTaskbar:true,width:1180,height:820,minWidth:960,minHeight:650,titleBarStyle:'hiddenInset',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});window.loadFile(${JSON.stringify(join(directory, "index.html"))},{query:{loading:'1'}});});app.on('window-all-closed',()=>app.quit());`,
  );
  return { directory, main };
}
