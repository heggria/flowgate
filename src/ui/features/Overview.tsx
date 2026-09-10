import { useState } from "react";
import {
  Button,
  Combobox,
  outletChoices,
  PageHeader,
  useTask,
  TaskError,
  InfoTip,
  Modal,
  FormFooter,
  Field,
  StatusBadge,
} from "../components";
import type { FeatureProps } from "../modules";
import { client, mutation } from "../../../packages/client/src/index";
import { Traffic } from "./Traffic";
import { TrafficChart } from "./TrafficChart";
import { Icon } from "../icons";
import { bytes, modeLabels } from "../format";
export function Overview({
  snapshot,
  save,
  navigate,
  busy,
  detailPanels,
}: FeatureProps) {
  const c = snapshot.configuration,
    connected = snapshot.kernel.status === "running",
    traffic = snapshot.traffic;
  const [switching, setSwitching] = useState(false),
    [nextOutlet, setNextOutlet] = useState(c.settings.selectedNode),
    [copied, setCopied] = useState(false);
  const task = useTask(),
    switchTask = useTask();
  const applied = snapshot.appliedConnection;
  const pending = connected && snapshot.kernel.appliedRevision !== c.revision;
  const selectedId =
    applied?.selectedNode ?? (pending ? undefined : c.settings.selectedNode);
  const choices = outletChoices(c).filter(
    (o) => !["block", "select"].includes(o.value),
  );
  const name = (id: string) =>
    choices.find((o) => o.value === id)?.label ?? "出口已移除";
  const activeName = connected
    ? (applied?.outletName ??
      (pending ? "旧配置 · 出口待确认" : name(c.settings.selectedNode)))
    : name(c.settings.selectedNode);
  const settings = connected
    ? (applied ?? (pending ? undefined : c.settings))
    : c.settings;
  const measurement = connected
    ? snapshot.nodeMeasurements?.find((m) => m.id === selectedId)
    : undefined;
  const available = connected && traffic?.available;
  const hasTraffic = Boolean(
    available && (traffic.flows.length || traffic.upload || traffic.download),
  );
  const canMeasure =
    connected && !pending && c.nodes.some((n) => n.id === selectedId);
  const importResources = () => {
    sessionStorage.setItem("flowgate.openImport", "1");
    navigate("nodes");
  };
  return (
    <>
      <PageHeader title="概览" />
      {snapshot.kernel.status === "failed" ||
      snapshot.kernel.status === "unknown" ? (
        <div className="alert alert-error" role="alert">
          {snapshot.kernel.message ?? "代理状态异常"}
          <Button className="quiet" onClick={() => navigate("activity")}>
            查看记录
          </Button>
        </div>
      ) : null}
      <section className="connectionhero" aria-label="当前连接与接入">
        <div className="heromain">
          <div className="herosymbol">
            <Icon name="network" size={24} />
          </div>
          <div className="heroidentity">
            <span className="eyebrow">
              {connected ? "当前生效出口" : "代理出口"}
            </span>
            <h2 title={activeName}>{activeName}</h2>
            <div className="herometa">
              <span>
                {settings ? modeLabels[settings.mode] : "接入方式待确认"}
              </span>
              <span aria-hidden="true">·</span>
              <StatusBadge
                tone={
                  measurement?.state === "failed"
                    ? "danger"
                    : measurement?.state === "succeeded"
                      ? "success"
                      : "neutral"
                }
              >
                {!connected || !measurement
                  ? "节点未检测"
                  : measurement.state === "running"
                    ? "检测中…"
                    : measurement.state === "succeeded"
                      ? `${measurement.delayMs} ms`
                      : "检测失败"}
              </StatusBadge>
              <InfoTip label="节点检测说明">{`${measurement?.measuredAt ? `上次检测 ${new Date(measurement.measuredAt).toLocaleString()}。` : ""}节点检测仅代表内核测试目标的结果。实际请求还取决于分流规则、DNS 与目标服务。`}</InfoTip>
            </div>
          </div>
          <div className="heroactions">
            {!c.nodes.length ? (
              <Button
                className="primary"
                aria-label="添加第一个节点"
                onClick={importResources}
              >
                <Icon name="nodes" size={15} />
                导入资源
              </Button>
            ) : null}
            <Button
              className="secondary"
              onClick={() => {
                setNextOutlet(c.settings.selectedNode);
                setSwitching(true);
              }}
            >
              切换出口
            </Button>
          </div>
        </div>
        <div className="heroaccess">
          {settings?.mode === "manual" ? (
            <>
              <span>HTTP / SOCKS</span>
              <code>127.0.0.1:{settings.listenPort}</code>
              <Button
                className="iconbutton"
                aria-label="复制代理地址"
                title={copied ? "已复制" : "复制代理地址"}
                onClick={() =>
                  void task.execute(async () => {
                    await navigator.clipboard.writeText(
                      `127.0.0.1:${settings.listenPort}`,
                    );
                    setCopied(true);
                  })
                }
              >
                <Icon name={copied ? "check" : "copy"} size={14} />
              </Button>
              <InfoTip label="应用接入示例">{`在目标应用的代理设置中填写该地址。终端示例：curl --proxy http://127.0.0.1:${settings.listenPort} https://example.com`}</InfoTip>
            </>
          ) : (
            <span>
              {settings?.mode === "tun"
                ? "网络层接入"
                : settings?.mode === "system"
                  ? "系统代理接入"
                  : "接入状态待确认"}
            </span>
          )}
          <div className="heroaccessactions">
            <Button
              className="quiet"
              disabled={!canMeasure}
              pending={task.pending || measurement?.state === "running"}
              title={
                !connected
                  ? "启动代理后可检测节点"
                  : pending
                    ? "应用配置后可检测节点"
                    : !canMeasure
                      ? "直连、策略组或外部网络请在目标应用中发起请求"
                      : "检测当前节点"
              }
              onClick={() =>
                void task.execute(() =>
                  client.request("node.measure", { id: selectedId }),
                )
              }
            >
              <Icon name="connections" size={14} />
              检测出口
            </Button>
            {measurement?.state === "failed" ? (
              <Button className="quiet" onClick={() => navigate("activity")}>
                排查失败
              </Button>
            ) : null}
            <Button className="quiet" onClick={() => navigate("settings")}>
              接入设置
              <Icon name="chevron" size={12} />
            </Button>
          </div>
        </div>
        <TaskError message={task.error} />
      </section>
      {connected && !hasTraffic ? (
        <div className="onboardingline">
          <span className="dot" />
          <span>等待应用接入</span>
          <InfoTip label="首次接入说明">
            在目标应用中填写上方代理地址，然后发起请求。到连接页核对出口，并检查目标服务的响应。
          </InfoTip>
          <Button
            className="textbutton"
            onClick={() => navigate("connections")}
          >
            查看连接
          </Button>
        </div>
      ) : null}
      {hasTraffic ? (
        <>
          <section className="metrics" aria-label="运行指标">
            {[
              {
                label: "下载速率",
                value: bytes(traffic!.downloadRate),
                unit: "/s",
                icon: "down",
                cls: "download",
              },
              {
                label: "上传速率",
                value: bytes(traffic!.uploadRate),
                unit: "/s",
                icon: "up",
                cls: "upload",
              },
              {
                label: "活跃连接",
                value:
                  traffic!.activeConnections ??
                  traffic!.flows.filter((f) => f.state === "active").length,
                unit: "",
                icon: "connections",
                cls: "",
              },
              {
                label: "会话流量",
                value: bytes(traffic!.upload + traffic!.download),
                unit: "",
                icon: "network",
                cls: "",
              },
            ].map((m) => (
              <div className="metric" key={m.label}>
                <div className="metriclabel">
                  <Icon name={m.icon} />
                  {m.label}
                </div>
                <div className={`metricvalue ${m.cls}`}>
                  {m.value}
                  <small>{m.unit}</small>
                </div>
              </div>
            ))}
          </section>
          <TrafficChart traffic={traffic} running={connected} />
        </>
      ) : null}
      <Traffic
        traffic={traffic}
        configuration={c}
        detailPanels={detailPanels}
        compact
        onExpand={() => navigate("connections")}
      />
      <div className="overviewfoot">
        <Button className="quiet" onClick={() => navigate("network")}>
          <Icon name="network" size={14} />
          {snapshot.network?.defaultInterface ?? "网络未检测"}
          <Icon name="chevron" size={12} />
        </Button>
        <Button className="quiet" onClick={() => navigate("rules")}>
          {c.rules.length} 条规则
          <Icon name="chevron" size={12} />
        </Button>
        <span>
          {pending ? "配置待应用" : connected ? "配置已应用" : "代理未启动"}
        </span>
      </div>
      {switching ? (
        <Modal
          title="切换出口"
          icon="nodes"
          onClose={() => setSwitching(false)}
          busy={switchTask.pending}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void switchTask.execute(async () => {
                const saved = await save(
                  {
                    ...c,
                    settings: { ...c.settings, selectedNode: nextOutlet },
                  },
                  { local: true },
                );
                if (!saved) return false;
                if (connected) await mutation("proxy.connect");
                setSwitching(false);
              });
            }}
          >
            <Field
              id="outbound"
              label="代理出口"
              hint={
                connected
                  ? "切换会应用全部已保存配置，并重新建立连接。"
                  : undefined
              }
            >
              <Combobox
                id="outbound"
                label="选择代理节点"
                disabled={switchTask.pending || busy}
                value={nextOutlet}
                options={choices}
                onChange={setNextOutlet}
              />
            </Field>
            <TaskError message={switchTask.error} />
            <FormFooter
              onClose={() => setSwitching(false)}
              pending={switchTask.pending}
              ready
              label={connected ? "切换并应用" : "保存出口"}
              hint={connected ? "会重新建立连接" : undefined}
            />
          </form>
        </Modal>
      ) : null}
    </>
  );
}
