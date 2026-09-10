import { Toggle, Button, Disclosure } from "../components";
import { useState } from "react";
import { useDraft } from "../drafts";
import { ReleaseUpdates } from "./ReleaseUpdates";
import { PageHeader, SettingRow, TaskError, useTask } from "../components";
import type { Configuration } from "../../../packages/contracts/src/index";
export function Settings({
  config,
  save,
  run,
  busy = false,
}: {
  config: Configuration;
  busy?: boolean;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const draft = useDraft("settings", {
    dns: config.settings.dnsServer,
    port: String(config.settings.listenPort),
  });
  const { dns, port } = draft.value,
    task = useTask(),
    [notice, setNotice] = useState("");
  const dirty =
    dns !== config.settings.dnsServer ||
    port !== String(config.settings.listenPort);
  const modes = [
    { id: "manual", name: "手动代理", description: "由应用自行接入" },
    { id: "system", name: "系统代理", description: "接管系统代理设置" },
    { id: "tun", name: "TUN", description: "接管网络层流量" },
  ];
  return (
    <div className="settingspage">
      <PageHeader title="设置" description="让 FlowGate 按你的方式工作。" />
      <section className="settingsgroup">
        <div className="groupheading">
          <h2>网络接入</h2>
          <p>选择流量接入方式与本地监听地址。</p>
        </div>
        <div className="modecards" role="radiogroup" aria-label="接入方式">
          {modes.map((mode) => (
            <label
              className={
                config.settings.mode === mode.id
                  ? "modecard selected"
                  : "modecard"
              }
              key={mode.id}
            >
              <Toggle
                type="radio"
                pending={busy || task.pending}
                name="connection-mode"
                value={mode.id}
                checked={config.settings.mode === mode.id}
                onChange={() => {
                  void save({
                    ...config,
                    settings: {
                      ...config.settings,
                      mode: mode.id as Configuration["settings"]["mode"],
                    },
                  });
                }}
              />
              <strong>{mode.name}</strong>
              <span>{mode.description}</span>
            </label>
          ))}
        </div>
        <p className="fieldhint modehint">
          {config.settings.mode === "manual"
            ? `在目标应用中填写 127.0.0.1:${config.settings.listenPort}，支持 HTTP 与 SOCKS。`
            : "此模式需要已安装且可用的系统辅助服务。"}
        </p>
        <div className="settingssurface">
          <SettingRow
            label="启动时恢复代理连接"
            description="使用上一次保存的配置，自动开始连接。"
            htmlFor="auto-connect"
          >
            <Toggle
              id="auto-connect"
              className="switchinput"
              type="checkbox"
              role="switch"
              pending={busy || task.pending}
              checked={config.settings.autoConnect}
              onChange={(e) => {
                void save({
                  ...config,
                  settings: {
                    ...config.settings,
                    autoConnect: e.target.checked,
                  },
                });
              }}
            />
          </SettingRow>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const success = await task.execute(async () => {
                const saved = await save(
                  {
                    ...config,
                    settings: {
                      ...config.settings,
                      listenPort: Number(port),
                      dnsServer: dns,
                    },
                  },
                  { local: true },
                );
                if (!saved) return false;
                await draft.clear({ dns, port });
              });
              if (success)
                setNotice("网络设置已保存，下次启动或应用配置时生效。");
            }}
          >
            <SettingRow
              label="本地端口"
              description="HTTP 与 SOCKS 共享一个监听端口。"
              htmlFor="listen-port"
            >
              <input
                id="listen-port"
                disabled={task.pending}
                className="portinput"
                type="number"
                required
                min="1024"
                max="65535"
                value={port}
                onChange={(e) => {
                  draft.change({ port: e.target.value });
                  setNotice("");
                }}
              />
            </SettingRow>
            <SettingRow
              label="DNS 服务器"
              description="用于默认出口的域名解析。"
              htmlFor="dns-server"
            >
              <input
                id="dns-server"
                disabled={task.pending}
                required
                spellCheck={false}
                value={dns}
                onChange={(e) => {
                  draft.change({ dns: e.target.value });
                  setNotice("");
                }}
              />
            </SettingRow>
            <TaskError message={task.error || draft.error} />
            {dirty || task.pending ? (
              <div className="settingssave">
                <span>有未保存的更改</span>
                <Button
                  type="button"
                  className="quiet"
                  pending={Boolean(task.pending)}
                  onClick={() => {
                    void draft.clear({
                      dns: config.settings.dnsServer,
                      port: String(config.settings.listenPort),
                    });
                  }}
                >
                  放弃更改
                </Button>
                <Button
                  className="primary"
                  pending={task.pending}
                  disabled={!draft.ready}
                >
                  {task.pending ? "保存中…" : "保存网络设置"}
                </Button>
              </div>
            ) : notice ? (
              <p className="settingsnotice" role="status">
                {notice}
              </p>
            ) : null}
          </form>
        </div>
        <Disclosure title="系统辅助服务">
          <SettingRow
            label="安装系统辅助服务"
            description="为系统代理和 TUN 模式提供所需的权限。"
          >
            <Button
              className="secondary"
              onClick={() => run(() => window.shell.request("helper.install"))}
            >
              安装系统辅助服务
            </Button>
          </SettingRow>
        </Disclosure>
      </section>
      <div className="settingsupdates">
        <ReleaseUpdates run={run} busy={busy || task.pending} />
      </div>
    </div>
  );
}
