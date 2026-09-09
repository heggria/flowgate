import { useDraft } from "../drafts";
import { useEffect, useState } from "react";
import type {
  Configuration,
  ReleaseSet,
} from "../../../packages/contracts/src/index";
export function Settings({
  config,
  save,
  run,
}: {
  config: Configuration;
  save: (c: Configuration) => Promise<boolean>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const draft = useDraft("settings", {
    dns: config.settings.dnsServer,
    port: String(config.settings.listenPort),
  });
  const { dns, port } = draft.value;
  const setDns = (dns: string) => draft.change({ dns }),
    setPort = (port: string) => draft.change({ port });
  const [releaseStatus, setReleaseStatus] = useState<{
    release: string;
    configured: boolean;
    updating?: boolean;
    revoked?: string[];
    channel?: "stable" | "preview";
    versions?: Record<string, unknown>;
  } | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [channel, setChannel] = useState<"stable" | "preview">("stable");
  useEffect(() => {
    void window.shell
      .request("release.status")
      .then((value: any) => {
        setReleaseStatus(value);
        setChannel(value.channel ?? "stable");
      })
      .catch(() => {});
  }, []);
  const [candidate, setCandidate] = useState<ReleaseSet | null>(null);
  return (
    <>
      <h1>设置</h1>
      {draft.error ? <p role="alert">{draft.error}</p> : null}
      <section className="panel">
        <h2>网络接入</h2>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={config.settings.autoConnect}
            onChange={(e) =>
              save({
                ...config,
                settings: { ...config.settings, autoConnect: e.target.checked },
              })
            }
          />{" "}
          启动时恢复代理连接
        </label>
        <label>
          接入方式
          <select
            value={config.settings.mode}
            onChange={(e) =>
              save({
                ...config,
                settings: {
                  ...config.settings,
                  mode: e.target.value as Configuration["settings"]["mode"],
                },
              })
            }
          >
            <option value="manual">手动代理</option>
            <option value="system">系统代理（需要特权服务）</option>
            <option value="tun">TUN（需要特权服务）</option>
          </select>
        </label>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await save({
              ...config,
              settings: {
                ...config.settings,
                listenPort: Number(port),
                dnsServer: dns,
              },
            });
            if (saved) await draft.clear({ dns, port });
          }}
        >
          <label>
            本地端口
            <input
              type="number"
              min="1024"
              max="65535"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </label>
          <label>
            DNS 服务器
            <input value={dns} onChange={(e) => setDns(e.target.value)} />
          </label>
          <button className="secondary" disabled={!draft.ready}>
            保存网络设置
          </button>
        </form>
        <button
          className="quiet"
          onClick={() => run(() => window.shell.request("helper.install"))}
        >
          安装系统辅助服务
        </button>
      </section>
      <section className="panel">
        <h2>官方模块</h2>
        <p>
          当前版本：{releaseStatus?.release ?? "读取中"} · 外壳{" "}
          {window.shell.version}
        </p>
        {releaseStatus && !releaseStatus.configured ? (
          <p className="hint">官方更新源尚未配置。</p>
        ) : null}
        {releaseStatus?.revoked?.includes(releaseStatus.release) ? (
          <p role="alert">
            当前版本已被官方撤回。为避免突然中断连接，本次运行暂时保留；请应用受信更新或恢复内置版本，下次启动将拒绝加载此版本。
          </p>
        ) : null}
        {releaseStatus?.revoked?.includes(releaseStatus.release) ? (
          <button
            className="secondary"
            onClick={() => run(() => window.shell.request("recovery.restore"))}
          >
            恢复内置版本
          </button>
        ) : null}
        <label>
          更新通道
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as "stable" | "preview");
              setCandidate(null);
            }}
          >
            <option value="stable">稳定版</option>
            <option value="preview">预览版</option>
          </select>
        </label>
        {updateMessage ? <p role="status">{updateMessage}</p> : null}

        <button
          className="secondary"
          onClick={() =>
            run(async () => {
              setCandidate(null);
              setUpdateMessage("正在验证更新目录…");
              try {
                const candidate = (await window.shell.request("release.check", {
                  channel,
                })) as ReleaseSet;
                setCandidate(candidate);
                setUpdateMessage("目录与文件验证通过，可以应用更新。");
              } catch (error) {
                setUpdateMessage(
                  error instanceof Error ? error.message : "更新检查失败",
                );
                throw error;
              } finally {
                setReleaseStatus(
                  (await window.shell.request("release.status")) as any,
                );
              }
            })
          }
        >
          检查更新
        </button>
        <details>
          <summary>组件版本</summary>
          <pre>{JSON.stringify(releaseStatus?.versions ?? {}, null, 2)}</pre>
        </details>
        {candidate?.releaseNotes ? <p>{candidate.releaseNotes}</p> : null}
        {candidate ? (
          <button
            className="primary"
            onClick={() =>
              run(() =>
                window.shell.request("release.activate", { id: candidate.id }),
              )
            }
          >
            应用 {candidate.id}
          </button>
        ) : null}
        <button
          className="quiet"
          onClick={() => run(() => window.shell.request("window.reload"))}
        >
          重新加载界面
        </button>
        <button
          className="quiet"
          onClick={() => run(() => window.shell.request("application.check"))}
        >
          检查完整应用更新
        </button>
      </section>
    </>
  );
}
