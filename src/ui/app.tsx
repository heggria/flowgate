import { useAppearance } from "./appearance";
import { Button, InfoTip } from "./components";
import React, {
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  AppSnapshot,
  Configuration,
} from "../../packages/contracts/src/index";
import {
  client,
  mutation,
  cancelPending,
  pendingCount,
  subscribePending,
} from "../../packages/client/src/index";
import {
  ModuleRuntime,
  TraceBuffer,
} from "../../packages/runtime/src/lifecycle";
import {
  modules,
  type CommandContribution,
  type DetailPanelContribution,
  type RouteContribution,
} from "./modules";
import { Icon } from "./icons";
import { kernelLabels } from "./format";
function App({ routes }: { routes: RouteContribution[] }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null),
    [page, setPage] = useState("overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState(""),
    [theme, setTheme] = useAppearance();
  const [settingsDraft, setSettingsDraft] = useState<{
    port?: string;
    dns?: string;
  } | null>(null);
  useEffect(() => {
    let active = true,
      updated = false;
    const change = (event: Event) => {
      const draft = (event as CustomEvent).detail;
      if (draft?.key === "settings") {
        updated = true;
        setSettingsDraft(draft.value);
      }
    };
    window.addEventListener("flowgate:draft", change);
    void window.shell
      .request("ui.draft.get", { key: "settings" })
      .then((value) => {
        if (active && !updated) setSettingsDraft(value as typeof settingsDraft);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("flowgate:draft", change);
    };
  }, []);
  const unsavedSettings = Boolean(
    snapshot &&
    settingsDraft &&
    (settingsDraft.port !==
      String(snapshot.configuration.settings.listenPort) ||
      settingsDraft.dns !== snapshot.configuration.settings.dnsServer),
  );
  const cancelable = useSyncExternalStore(subscribePending, pendingCount);
  const search = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    window.scrollTo({ top: 0 });
    const heading = document.querySelector<HTMLElement>(".content h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [page]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(
    () =>
      window.shell.onNavigate?.((route) => {
        if (route === "__search") search.current?.focus();
        else if (routes.some((r) => r.id === route)) setPage(route);
      }),
    [routes],
  );
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  useEffect(() => {
    let mounted = true;
    const update = (s: AppSnapshot) => {
      if (mounted) {
        latestSnapshot = s;
        setSnapshot(s);
        void window.shell.request("ui.ready");
      }
    };
    client
      .request<AppSnapshot>("snapshot")
      .then((s) => {
        update(s);
        if (!s.network) void client.request("network.refresh").catch(() => {});
      })
      .catch((e) => setError(e.message));
    const unsubscribe = client.subscribe(update);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const save = async (c: Configuration, options?: { local?: boolean }) => {
    if (options?.local) {
      const result = await mutation("configuration.save", c);
      setSnapshot(result.snapshot);
      return true;
    }
    let saved = false;
    await run(async () => {
      const result = await mutation("configuration.save", c);
      setSnapshot(result.snapshot);
      saved = true;
    });
    if (saved) setNotice("配置已保存");
    return saved;
  };
  const commands = runtime.entries
    .filter((entry) => entry.kind === "command")
    .map((entry) => entry.value as CommandContribution);
  const matches = (label: string, id = "") => {
    const synonyms: Record<string, string> = {
      overview: "首页 home status 状态",
      nodes: "代理 proxy subscription 导入 订阅 server",
      rules: "分流 policy route routing",
      connections: "流量 traffic 请求",
      network: "vpn tun coexist 共存",
      activity: "日志 log error 错误 失败",
      extensions: "插件 plugin",
      settings: "偏好 preference dns port 端口 update 更新",
    };
    return `${label} ${id} ${synonyms[id] ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  };
  const objectResults =
    query.trim() && snapshot
      ? [
          ...snapshot.configuration.nodes
            .filter((n) =>
              `${n.name} ${n.server}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .slice(0, 5)
            .map((n) => ({
              id: n.id,
              label: n.name,
              page: "nodes",
              query: n.name,
            })),
          ...snapshot.configuration.rules
            .filter((r) =>
              r.value.toLowerCase().includes(query.trim().toLowerCase()),
            )
            .slice(0, 5)
            .map((r) => ({
              id: r.id,
              label: r.value,
              page: "rules",
              query: r.value,
            })),
        ]
      : [];
  const openObject = (entry: (typeof objectResults)[number]) => {
    sessionStorage.setItem(`flowgate.search.${entry.page}`, entry.query);
    setPage(entry.page);
    setQuery("");
    window.dispatchEvent(new CustomEvent("flowgate:search", { detail: entry }));
  };
  const route = routes.find((r) => r.id === page) ?? routes[0];
  const navigate = (id: string) => {
    if (id === "updates") {
      setPage("settings");
      sessionStorage.setItem("flowgate.showUpdates", "1");
      requestAnimationFrame(() =>
        document
          .getElementById("about-updates")
          ?.scrollIntoView({ block: "start" }),
      );
    } else setPage(id);
  };
  const SelectedPage = route.Component;
  const connected = snapshot?.kernel.status === "running";
  const transitioning =
    snapshot && ["starting", "stopping"].includes(snapshot.kernel.status);
  const pendingConfiguration =
    connected &&
    snapshot.kernel.appliedRevision !== snapshot.configuration.revision;
  return (
    <div className="app">
      {cancelable > 0 ? (
        <Button
          className="cancelrequests secondary"
          onClick={() => {
            void cancelPending().catch((error) => setError(String(error)));
          }}
        >
          取消当前请求（{cancelable}）
        </Button>
      ) : null}
      {notice ? (
        <div className="toast" role="status">
          <span className="dot online" />
          {notice}
        </div>
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">
            <Icon name="brand" size={22} />
          </span>
          FlowGate
        </div>
        <div className="navsearch">
          <Icon name="search" size={14} />
          <input
            ref={search}
            aria-label="查找功能"
            placeholder="查找功能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key === "Enter" && query.trim()) {
                const first = routes.find((r) => matches(r.label, r.id));
                if (first) {
                  setPage(first.id);
                  setQuery("");
                  search.current?.blur();
                } else if (snapshot) {
                  const command = commands.find((command) =>
                    matches(command.label, command.id),
                  );
                  if (command) {
                    void run(() =>
                      command.execute({ navigate: setPage, snapshot }),
                    );
                    setQuery("");
                  } else if (objectResults[0]) openObject(objectResults[0]);
                }
              }
            }}
          />
          <kbd>⌘ K</kbd>
        </div>
        <nav aria-label="主导航">
          {routes
            .filter((r) => matches(r.label, r.id))
            .map((r) => (
              <Button
                key={r.id}
                aria-label={r.label}
                title={r.label}
                aria-current={page === r.id ? "page" : undefined}
                className={`nav ${page === r.id ? "active" : ""} ${r.id === "settings" ? "settingsnav" : ""}`}
                onClick={() => {
                  setPage(r.id);
                  setQuery("");
                }}
              >
                <Icon name={r.id} />
                <span>{r.label}</span>
                {r.id === "settings" && unsavedSettings ? (
                  <small className="draftbadge">草稿</small>
                ) : null}
                {r.id === "nodes" && snapshot ? (
                  <small>{snapshot.configuration.nodes.length}</small>
                ) : null}
              </Button>
            ))}
          {query && snapshot
            ? commands
                .filter((command) => matches(command.label, command.id))
                .map((command) => (
                  <Button
                    key={command.id}
                    className="nav"
                    pending={Boolean(busy)}
                    onClick={() => {
                      void run(() =>
                        command.execute({ navigate: setPage, snapshot }),
                      );
                      setQuery("");
                    }}
                  >
                    {command.label}
                  </Button>
                ))
            : null}
          {objectResults.map((entry) => (
            <Button
              key={`${entry.page}-${entry.id}`}
              className="nav objectresult"
              title={entry.label}
              onClick={() => openObject(entry)}
            >
              <Icon name={entry.page} />
              <span>{entry.label}</span>
            </Button>
          ))}
          {query &&
          !objectResults.length &&
          !routes.some((r) => matches(r.label, r.id)) &&
          !commands.some((command) => matches(command.label, command.id)) ? (
            <p className="navempty">没有匹配功能</p>
          ) : null}
        </nav>
        <div className="sidebarbottom">
          <span className="version">FlowGate {window.shell.version}</span>
          <Button
            className="iconbutton"
            aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            <Icon name="sun" size={16} />
          </Button>
        </div>
      </aside>
      <main>
        <header className="toolbar">
          <span className="toolbarlocation">{route.label}</span>
          <div className="toolbarcontrols">
            <span className={`kernelstatus ${connected ? "running" : ""}`}>
              <i className={connected ? "dot online" : "dot"} />
              {snapshot ? kernelLabels[snapshot.kernel.status] : "连接服务中"}
            </span>
            <Button
              className="iconbutton"
              aria-label="刷新状态"
              title="刷新网络状态"
              pending={Boolean(busy)}
              onClick={() => run(() => client.request("network.refresh"))}
            >
              <Icon name="refresh" size={16} />
            </Button>
            <span className="toolbarseparator" />
            <Button
              className={
                connected ? "secondary connectbutton" : "primary connectbutton"
              }
              pending={busy || Boolean(transitioning)}
              disabled={!snapshot}
              onClick={() =>
                run(() =>
                  mutation(connected ? "proxy.disconnect" : "proxy.connect"),
                )
              }
            >
              <Icon name="power" size={14} />
              {transitioning ? "切换中…" : connected ? "停止代理" : "启动代理"}
            </Button>
          </div>
        </header>
        {error ? (
          <div role="alert" className="alert alert-error">
            {error}
            <Button aria-label="关闭错误" onClick={() => setError("")}>
              <Icon name="close" size={14} />
            </Button>
          </div>
        ) : null}
        {pendingConfiguration ? (
          <div className="configurationbar" role="status">
            <div>
              <strong>有配置等待生效</strong>
              {snapshot?.appliedConnection?.selectedNode !==
              snapshot?.configuration.settings.selectedNode ? (
                <span>
                  当前{" "}
                  {snapshot?.appliedConnection?.outletName ??
                    "旧配置（出口待确认）"}{" "}
                  → 待应用{" "}
                  {snapshot
                    ? (snapshot.configuration.nodes.find(
                        (n) =>
                          n.id === snapshot.configuration.settings.selectedNode,
                      )?.name ??
                      snapshot.configuration.groups?.find(
                        (g) =>
                          g.id === snapshot.configuration.settings.selectedNode,
                      )?.name ??
                      snapshot.configuration.externalNetworks?.find(
                        (n) =>
                          n.id === snapshot.configuration.settings.selectedNode,
                      )?.name ??
                      (snapshot.configuration.settings.selectedNode === "direct"
                        ? "直连"
                        : snapshot.configuration.settings.selectedNode))
                    : ""}
                </span>
              ) : null}
            </div>
            <InfoTip label="应用配置说明">
              {`已保存修订 ${snapshot?.configuration.revision} · 当前生效修订 ${snapshot?.kernel.appliedRevision ?? "未知"}。应用会重新建立连接，并包含所有已保存的规则、接入方式和端口更改。`}
            </InfoTip>
            <Button
              className="primary"
              pending={Boolean(busy)}
              onClick={() => run(() => mutation("proxy.connect"))}
            >
              应用配置
            </Button>
          </div>
        ) : null}
        {snapshot ? (
          <div className="content" data-page={page}>
            <fieldset className="workspacefields" aria-busy={busy}>
              <SelectedPage
                detailPanels={runtime.entries
                  .filter((entry) => entry.kind === "detailPanel")
                  .map((entry) => entry.value as DetailPanelContribution)}
                settingsContributions={runtime.entries
                  .filter((entry) => entry.kind === "settings")
                  .map(
                    (entry) =>
                      entry.value as React.ComponentType<
                        import("./modules").FeatureProps
                      >,
                  )}
                snapshot={snapshot}
                save={save}
                run={run}
                navigate={navigate}
                busy={busy}
              />
            </fieldset>
          </div>
        ) : (
          <div className="empty loadingstate" role="status">
            <span className="loadingring" />
            正在连接服务…
          </div>
        )}
        <footer className="statusbar">
          <span>
            <i
              className={snapshot?.lifecycle === "ready" ? "dot online" : "dot"}
            />
            {snapshot?.lifecycle === "ready" ? "服务就绪" : "服务连接中"}
          </span>
          <span>{snapshot?.network?.defaultInterface ?? "网络未检测"}</span>
          <span className="statusright">
            {busy
              ? "正在处理操作…"
              : pendingConfiguration
                ? "配置待生效"
                : "仅统计经过 FlowGate 的流量"}
          </span>
        </footer>
      </main>
    </div>
  );
}
let latestSnapshot: AppSnapshot;
let rendererContext: import("../../packages/contracts/src/index").TraceContext;
const runtime = new ModuleRuntime(new TraceBuffer(), () => ({
  ...rendererContext,
  configRevision: latestSnapshot?.configuration.revision,
  serviceVersion: latestSnapshot?.serviceVersion,
  serviceEpoch: latestSnapshot?.epoch,
}));
let traceFlush = Promise.resolve();
runtime.trace.onChange = () => {
  const event = runtime.trace.snapshot().at(-1)!;
  traceFlush = traceFlush
    .catch(() => {})
    .then(async () => {
      await window.shell.request("ui.trace", event);
    });
};
const workspaceRoot = createRoot(document.getElementById("root")!);
workspaceRoot.render(
  <div className="empty loadingstate" role="status">
    <span className="loadingring" />
    正在连接服务…
  </div>,
);
void (async () => {
  [latestSnapshot, rendererContext] = await Promise.all([
    client.request<AppSnapshot>("snapshot"),
    window.shell.request("ui.context") as Promise<
      import("../../packages/contracts/src/index").TraceContext
    >,
  ]);
  await runtime.activate(modules);
  window.shell.setReleaseHandler?.(async () => {
    await runtime.stop();
    await traceFlush;
  });
  workspaceRoot.render(
    <App
      routes={runtime.entries
        .filter((e) => e.kind === "route")
        .map((e) => e.value as RouteContribution)}
    />,
  );
})().catch(() => {
  workspaceRoot.render(
    <div className="empty" role="alert">
      工作区启动失败，请重新打开应用或使用恢复页面。
    </div>,
  );
});
