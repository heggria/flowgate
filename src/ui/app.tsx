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
import { ModuleRuntime } from "../../packages/runtime/src/lifecycle";
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
    [query, setQuery] = useState(""),
    [theme, setTheme] = useState(
      () => localStorage.getItem("flowgate.theme") ?? "light",
    );
  const cancelable = useSyncExternalStore(subscribePending, pendingCount);
  const search = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      window.shell.onNavigate?.((route) => {
        if (routes.some((r) => r.id === route)) setPage(route);
      }),
    [routes],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("flowgate.theme", theme);
  }, [theme]);
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
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const save = async (c: Configuration) => {
    let saved = false;
    await run(async () => {
      const result = await mutation("configuration.save", c);
      setSnapshot(result.snapshot);
      saved = true;
    });
    return saved;
  };
  const commands = runtime.entries
    .filter((entry) => entry.kind === "command")
    .map((entry) => entry.value as CommandContribution);
  const route = routes.find((r) => r.id === page) ?? routes[0];
  const SelectedPage = route.Component;
  const connected = snapshot?.kernel.status === "running";
  return (
    <div className="app">
      {cancelable > 0 ? (
        <button
          className="cancelrequests secondary"
          onClick={() => {
            void cancelPending().catch((error) => setError(String(error)));
          }}
        >
          取消当前请求
        </button>
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">
            <Icon name="connections" size={20} />
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
              if (e.key === "Enter") {
                const first = routes.find((r) => r.label.includes(query));
                if (first) {
                  setPage(first.id);
                  setQuery("");
                  search.current?.blur();
                } else if (snapshot) {
                  const command = commands.find((command) =>
                    command.label.includes(query),
                  );
                  if (command) {
                    void run(() =>
                      command.execute({ navigate: setPage, snapshot }),
                    );
                    setQuery("");
                  }
                }
              }
            }}
          />
          <kbd>⌘ K</kbd>
        </div>
        <nav aria-label="主导航">
          {routes
            .filter((r) => r.label.includes(query))
            .map((r) => (
              <button
                key={r.id}
                aria-current={page === r.id ? "page" : undefined}
                className={`nav ${page === r.id ? "active" : ""} ${r.id === "settings" ? "settingsnav" : ""}`}
                onClick={() => {
                  setPage(r.id);
                  setQuery("");
                }}
              >
                <Icon name={r.id} />
                <span>{r.label}</span>
                {r.id === "nodes" && snapshot ? (
                  <small>{snapshot.configuration.nodes.length}</small>
                ) : null}
              </button>
            ))}
          {query && snapshot
            ? commands
                .filter((command) => command.label.includes(query))
                .map((command) => (
                  <button
                    key={command.id}
                    className="nav"
                    disabled={busy}
                    onClick={() => {
                      void run(() =>
                        command.execute({ navigate: setPage, snapshot }),
                      );
                      setQuery("");
                    }}
                  >
                    {command.label}
                  </button>
                ))
            : null}
          {query &&
          !routes.some((r) => r.label.includes(query)) &&
          !commands.some((command) => command.label.includes(query)) ? (
            <p className="navempty">没有匹配功能</p>
          ) : null}
        </nav>
        <div className="sidebarbottom">
          <span className="version">FlowGate 0.2</span>
          <button
            className="iconbutton"
            aria-label={theme === "light" ? "切换深色外观" : "切换浅色外观"}
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          >
            <Icon name="sun" size={16} />
          </button>
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
            <button
              className="iconbutton"
              aria-label="刷新状态"
              title="刷新网络状态"
              disabled={busy}
              onClick={() => run(() => client.request("network.refresh"))}
            >
              <Icon name="refresh" size={16} />
            </button>
            <span className="toolbarseparator" />
            <button
              className={
                connected ? "secondary connectbutton" : "primary connectbutton"
              }
              disabled={busy || !snapshot}
              onClick={() =>
                run(() =>
                  mutation(connected ? "proxy.disconnect" : "proxy.connect"),
                )
              }
            >
              <Icon name="power" size={14} />
              {busy ? "处理中" : connected ? "停止代理" : "启动代理"}
            </button>
          </div>
        </header>
        {error ? (
          <div role="alert" className="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
        {snapshot ? (
          <div className="content">
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
              navigate={setPage}
              busy={busy}
            />
          </div>
        ) : (
          <div className="empty">正在连接服务…</div>
        )}
        <footer className="statusbar">
          <span>
            <i
              className={snapshot?.lifecycle === "ready" ? "dot online" : "dot"}
            />
            {snapshot?.lifecycle === "ready" ? "服务就绪" : "服务连接中"}
          </span>
          <span>{snapshot?.network?.defaultInterface ?? "网络未检测"}</span>
          <span className="statusright">仅统计经过 FlowGate 的流量</span>
        </footer>
      </main>
    </div>
  );
}
const runtime = new ModuleRuntime();
void runtime
  .activate(modules)
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <App
        routes={runtime.entries
          .filter((e) => e.kind === "route")
          .map((e) => e.value as RouteContribution)}
      />,
    ),
  );
