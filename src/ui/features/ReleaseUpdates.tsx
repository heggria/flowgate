import {
  Button,
  Combobox,
  SettingRow,
  Disclosure,
  StatusBadge,
  TaskError,
} from "../components";
import { useEffect, useState } from "react";
import type { ReleaseSet } from "../../../packages/contracts/src/index";
import type { ExtensionState } from "../../../packages/contracts/src/extensions";
export function ReleaseUpdates({
  run,
  busy = false,
  extensions,
}: {
  run: (action: () => Promise<unknown>) => Promise<void>;
  busy?: boolean;
  extensions?: ExtensionState[];
}) {
  const [releaseStatus, setReleaseStatus] = useState<{
    release: string;
    configured: boolean;
    updating?: boolean;
    revoked?: string[];
    channel?: "stable" | "preview";
    versions?: Record<string, unknown>;
    events?: { stage: string; at: string; releaseSet: string }[];
  } | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const [checking, setChecking] = useState(false),
    [updateFailed, setUpdateFailed] = useState(false);
  const [channel, setChannel] = useState<"stable" | "preview">("stable");
  useEffect(() => {
    let active = true;
    void window.shell
      .request("release.status")
      .then((value: any) => {
        if (!active) return;
        setReleaseStatus(value);
        setChannel(value.channel ?? "stable");
      })
      .catch(() => {
        if (active) {
          setUpdateMessage("读取更新状态失败，请重试。");
          setUpdateFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  const [candidate, setCandidate] = useState<ReleaseSet | null>(null);
  return (
    <section className="settingsgroup releaseupdates">
      <div className="groupheading">
        <h2>官方扩展更新</h2>
        <p className="hint">
          内置扩展随经过验证的版本组合更新。核心组件和依赖保持兼容，原生组件通过完整应用更新。
        </p>
      </div>
      <div className="settingssurface">
        <SettingRow
          label="当前版本"
          description={`应用 ${window.shell.version}`}
        >
          <StatusBadge wrap>{releaseStatus?.release ?? "读取中"}</StatusBadge>
        </SettingRow>
        {releaseStatus && !releaseStatus.configured ? (
          <p className="hint">官方更新源尚未配置。</p>
        ) : null}
        {releaseStatus?.revoked?.includes(releaseStatus.release) ? (
          <p className="taskerror" role="alert">
            当前版本已被官方撤回。为避免突然中断连接，本次运行暂时保留；请应用受信更新或恢复内置版本，下次启动将拒绝加载此版本。
          </p>
        ) : null}
        {releaseStatus?.revoked?.includes(releaseStatus.release) ? (
          <Button
            className="secondary"
            onClick={() => run(() => window.shell.request("recovery.restore"))}
          >
            恢复内置版本
          </Button>
        ) : null}
        <SettingRow
          label="更新通道"
          description="预览版用于提前体验新功能。"
          htmlFor="update-channel"
        >
          <Combobox
            id="update-channel"
            label="更新通道"
            disabled={busy || checking || releaseStatus?.updating}
            value={channel}
            options={[
              { value: "stable", label: "稳定版" },
              { value: "preview", label: "预览版" },
            ]}
            onChange={(value) => {
              setChannel(value as "stable" | "preview");
              setCandidate(null);
            }}
          />
        </SettingRow>
      </div>

      {updateFailed ? (
        <TaskError message={updateMessage} />
      ) : updateMessage ? (
        <p className="inlinestatus" role="status">
          {updateMessage}
        </p>
      ) : null}

      <Button
        className="secondary"
        pending={Boolean(busy || checking || releaseStatus?.updating)}
        onClick={() =>
          run(async () => {
            setCandidate(null);
            setChecking(true);
            setUpdateFailed(false);
            setUpdateMessage("正在验证更新目录…");
            try {
              const candidate = (await window.shell.request("release.check", {
                channel,
              })) as ReleaseSet;
              setCandidate(candidate);
              setUpdateMessage("目录与文件验证通过，可以应用更新。");
            } catch (error) {
              setUpdateFailed(true);
              setUpdateMessage(
                error instanceof Error ? error.message : "更新检查失败",
              );
              throw error;
            } finally {
              setChecking(false);
              setReleaseStatus(
                (await window.shell.request("release.status")) as any,
              );
            }
          })
        }
      >
        {checking ? "检查中…" : "检查更新"}
      </Button>
      <Disclosure title="组件版本">
        <pre>{JSON.stringify(releaseStatus?.versions ?? {}, null, 2)}</pre>
      </Disclosure>
      {candidate ? (
        <section aria-label="候选版本详情" className="extensioncandidate">
          <h3>{candidate.id}</h3>
          <p>
            {candidate.channel === "stable" ? "稳定版" : "预览版"} ·
            协议兼容检查已通过
          </p>
          <p>{candidate.releaseNotes || "此版本未提供发布说明。"}</p>
          <ul>
            {candidate.builtins.map((entry) => (
              <li key={entry.id}>
                {extensions?.find((item) => item.id === entry.id)?.name ??
                  entry.id}{" "}
                · {entry.version}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {releaseStatus?.events?.length ? (
        <Disclosure title="最近更新过程">
          <ol>
            {releaseStatus.events.slice(-8).map((event, index) => (
              <li key={index}>
                {new Date(event.at).toLocaleString()} ·{" "}
                {(
                  {
                    verifying: "验证版本",
                    preflight: "兼容预检",
                    draining: "等待任务排空",
                    "ui-switch": "更新界面",
                    "service-switch": "切换服务",
                    rollback: "回退版本",
                    failed: "更新失败",
                    finished: "操作结束",
                  } as Record<string, string>
                )[event.stage] ?? event.stage}
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
      {candidate ? (
        <Button
          className="primary"
          pending={Boolean(busy || checking || releaseStatus?.updating)}
          onClick={() =>
            run(() =>
              window.shell.request("release.activate", { id: candidate.id }),
            )
          }
        >
          应用 {candidate.id}
        </Button>
      ) : null}
      <div className="sectionactions">
        <Button
          className="quiet"
          pending={Boolean(busy || checking)}
          onClick={() => run(() => window.shell.request("window.reload"))}
        >
          重新加载界面
        </Button>
        <Button
          className="quiet"
          pending={Boolean(busy || checking)}
          onClick={() => run(() => window.shell.request("application.check"))}
        >
          检查完整应用更新
        </Button>
      </div>
    </section>
  );
}
