import { Toggle, Button, InfoTip } from "../components";
import { useEffect, useState } from "react";
import { useDraft } from "../drafts";
import { ReleaseUpdates } from "./ReleaseUpdates";
import { PageHeader, SettingRow, TaskError, useTask } from "../components";
import type { Configuration } from "../../../packages/contracts/src/index";
export function Settings({
  config,
  save,
  run,
  busy = false,
  systemControl = false,
}: {
  config: Configuration;
  systemControl?: boolean;
  busy?: boolean;
  save: (c: Configuration, options?: { local?: boolean }) => Promise<boolean>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  useEffect(() => {
    if (sessionStorage.getItem("flowgate.showUpdates") === "1") {
      sessionStorage.removeItem("flowgate.showUpdates");
      const section = document.getElementById("about-updates");
      section?.scrollIntoView({ block: "start" });
      const heading = section?.querySelector("h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
  }, []);
  const draft = useDraft("settings", {
    dns: config.settings.dnsServer,
    port: String(config.settings.listenPort),
  });
  const { dns, port } = draft.value,
    task = useTask(),
    [notice, setNotice] = useState("");
  const [helper, setHelper] = useState<{
    installed: boolean;
    compatible: boolean;
    message: string;
  }>();
  const [helperBusy, setHelperBusy] = useState(false);
  useEffect(() => {
    let active = true;
    window.shell
      .request("helper.info")
      .then((value) => {
        if (active) setHelper(value as typeof helper);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  async function helperAction(method: "helper.install" | "helper.uninstall") {
    setHelperBusy(true);
    try {
      await run(async () => {
        try {
          await window.shell.request(method);
        } finally {
          setHelper(
            (await window.shell.request("helper.info")) as typeof helper,
          );
        }
      });
    } finally {
      setHelperBusy(false);
    }
  }
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
      <PageHeader title="设置" />
      <section className="settingsgroup">
        <div className="groupheading">
          <div className="headinglabel">
            <h2>网络接入</h2>
            <InfoTip label="设置保存说明">
              模式与开关即时保存；端口和 DNS
              先保存草稿。已保存配置在下次启动或点击应用配置后生效。
            </InfoTip>
          </div>
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
                disabled={mode.id !== "manual" && !systemControl}
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
            </label>
          ))}
        </div>
        <div className="sectionactions">
          <Button
            className="quiet"
            disabled={busy || helperBusy}
            onClick={() => void helperAction("helper.install")}
          >
            {helperBusy
              ? "处理中…"
              : helper?.installed
                ? "更新辅助服务"
                : "安装系统辅助服务"}
          </Button>
          {helper?.installed && (
            <Button
              className="quiet"
              disabled={busy || helperBusy}
              onClick={() => void helperAction("helper.uninstall")}
            >
              卸载辅助服务
            </Button>
          )}
          <InfoTip label="系统辅助服务说明">
            {helper?.message ?? "免费本机使用，无需 Apple 开发者会员。"}{" "}
            安装或卸载前请先断开代理连接。
          </InfoTip>
        </div>
        <div className="settingssurface">
          <SettingRow
            label="启动时恢复代理连接"

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
      </section>
      <div className="settingsupdates" id="about-updates">
        <ReleaseUpdates run={run} busy={busy || task.pending} />
      </div>
    </div>
  );
}
