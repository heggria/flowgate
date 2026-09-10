import {
  Button,
  EmptyState,
  InfoTip,
  Disclosure,
  TaskError as NetworkError,
} from "../components";
import { useState } from "react";
import {
  Combobox,
  Field,
  FormFooter,
  Modal,
  PageHeader,
  TaskError,
  useTask,
} from "../components";
import { ConfirmAction } from "../ConfirmAction";
import { client } from "../../../packages/client/src/index";
import { useDraft } from "../drafts";
import type { FeatureProps } from "../modules";
export function Network({ snapshot, save, run, navigate }: FeatureProps) {
  const [adding, setAdding] = useState(false);
  const task = useTask();
  const close = () => setAdding(false);
  const draft = useDraft("network", { selected: "", dns: "" });
  const { selected, dns } = draft.value;
  const setSelected = (selected: string) => draft.change({ selected }),
    setDns = (dns: string) => draft.change({ dns });
  const c = snapshot.configuration;
  return (
    <>
      <PageHeader title="网络环境">
        <Button className="primary" onClick={() => setAdding(true)}>
          ＋ 绑定网络
        </Button>
      </PageHeader>
      <NetworkError message={draft.error} />
      <section className="panel" aria-label="网络共存概况">
        <div className="paneltitle">
          <h2>网络共存</h2>
          <InfoTip label="网络观测说明">
            这是最近一次系统观测，不保证所有流量可分流。接口归属无法确认时保持未知，不依据接口名判断
            VPN 品牌。
          </InfoTip>
        </div>
        <div className="connectionfacts">
          <div>
            <span>默认路径</span>
            <strong>{snapshot.network?.defaultInterface ?? "未检测"}</strong>
          </div>
          <div>
            <span>系统代理 / PAC</span>
            <strong>
              {snapshot.network
                ? `${snapshot.network.proxyEnabled ? "已开启" : "未开启"}${snapshot.network.pacEnabled ? " · PAC" : ""}`
                : "未检测"}
            </strong>
          </div>
          <div>
            <span>共存检查</span>
            <strong>
              {snapshot.networkConflicts?.some((i) => i.severity === "blocked")
                ? "存在冲突"
                : snapshot.networkConflicts?.length
                  ? "有使用限制"
                  : snapshot.network
                    ? "未发现已知冲突"
                    : "待检测"}
            </strong>
          </div>
        </div>
        <div className="sectionactions">
          <Button
            className="secondary"
            onClick={() => run(() => client.request("network.refresh"))}
          >
            刷新网络
          </Button>
          <Button className="quiet" onClick={() => navigate("nodes")}>
            导入外部代理
          </Button>
          <span className="hint">
            {snapshot.network
              ? new Date(snapshot.network.capturedAt).toLocaleTimeString()
              : ""}
          </span>
        </div>
      </section>
      {snapshot.networkConflicts?.map((issue) => (
        <p
          key={issue.id}
          role={issue.severity === "blocked" ? "alert" : "status"}
          className={
            issue.severity === "blocked"
              ? "taskerror"
              : "inlinestatus notice-warning"
          }
        >
          {issue.message}
        </p>
      ))}
      {snapshot.network?.pacEnabled ? (
        <div className="headinglabel">
          <span>PAC 已开启</span>
          <InfoTip label="PAC 共存说明">
            PAC
            会按目标动态选路，不能当作单一出口。本应用保留其设置，手动代理模式可独立使用。
          </InfoTip>
        </div>
      ) : null}
      {(snapshot.network?.systemProxies?.length ?? 0) > 0 ? (
        <section className="panel">
          <h2>已观察的系统代理</h2>
          {snapshot.network!.systemProxies!.map((proxy) => (
            <div className="entry" key={proxy.kind}>
              <strong>
                {proxy.kind.toUpperCase()} · {proxy.host}:{proxy.port}
              </strong>
              <Button
                className="secondary"
                disabled={
                  proxy.port === c.settings.listenPort &&
                  ["127.0.0.1", "localhost", "::1"].includes(proxy.host)
                }
                onClick={() =>
                  run(() =>
                    client.request("subscription.import", {
                      text: JSON.stringify([
                        {
                          type: proxy.kind === "socks" ? "socks" : "http",
                          server: proxy.host,
                          server_port: proxy.port,
                          tag: "系统代理 " + proxy.kind,
                        },
                      ]),
                    }),
                  )
                }
              >
                添加为可选出口
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      <section className="resourcesection">
        <div className="resourcetools">
          <h2>
            外部网络{" "}
            <span className="count">{c.externalNetworks?.length ?? 0}</span>
          </h2>
          <span className="hint">接口与 DNS 成对绑定</span>
        </div>
        {!c.externalNetworks?.length ? (
          <p className="sectionempty">
            尚未绑定外部网络。绑定后，可以在分流规则中选择它。
          </p>
        ) : null}
        {adding ? (
          <Modal
            title="绑定外部网络"
            description="为此网络指定接口与解析器，作为独立出口。"
            icon="network"
            onClose={close}
            busy={task.pending}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!selected) {
                  task.setError("请选择一个已观察的网络接口。");
                  return;
                }
                void task.execute(async () => {
                  const saved = await save(
                    {
                      ...c,
                      externalNetworks: [
                        ...(c.externalNetworks ?? []),
                        {
                          id: crypto.randomUUID(),
                          name: selected,
                          interface: selected,
                          dnsServer: dns,
                        },
                      ],
                    },
                    { local: true },
                  );
                  if (!saved) return false;
                  await draft.clear({ selected: "", dns: "" });
                  close();
                });
              }}
            >
              <Field id="external-interface" label="外部网络接口">
                <Combobox
                  id="external-interface"
                  label="外部网络接口"
                  value={selected}
                  onChange={setSelected}
                  placeholder="选择已观察的接口"
                  options={(snapshot.network?.interfaces ?? [])
                    .filter((i) => i.name !== "lo0")
                    .map((i) => ({
                      value: i.name,
                      label: i.name,
                      detail: i.addresses.join(" · "),
                    }))}
                />
              </Field>
              <Field
                id="external-dns"
                label="外部网络 DNS"
                hint="使用该网络提供的解析器地址。"
              >
                <input
                  id="external-dns"
                  required
                  value={dns}
                  onChange={(e) => setDns(e.target.value)}
                  placeholder="udp://10.0.0.1"
                />
              </Field>
              <p className="fieldhint">
                接口消失时连接会失败，不会自动切换到其他出口。
              </p>
              <TaskError message={task.error || draft.error} />
              <FormFooter
                onClose={close}
                pending={task.pending}
                ready={draft.ready}
                label="添加网络"
              />
            </form>
          </Modal>
        ) : null}
        {(c.externalNetworks ?? []).map((n) => (
          <div className="entry networkbinding" key={n.id}>
            <div className="entrycopy">
              <strong>{n.name}</strong>
              <span className="badge">
                {c.rules.some((r) => r.outbound === n.id) ||
                c.settings.selectedNode === n.id ||
                c.settings.finalOutbound === n.id
                  ? "已被配置使用"
                  : "可选出口"}
              </span>
              <small>
                <code>{n.dnsServer}</code>
              </small>
            </div>
            <ConfirmAction
              label="移除"
              title={`移除网络「${n.name}」？`}
              description="引用此网络的规则会一并移除；若它是所选出口，配置将回到直连。外部软件本身的网络设置不会改变。"
              onConfirm={() =>
                save({
                  ...c,
                  externalNetworks: c.externalNetworks?.filter(
                    (x) => x.id !== n.id,
                  ),
                  rules: c.rules.filter((r) => r.outbound !== n.id),
                  settings: {
                    ...c.settings,
                    selectedNode:
                      c.settings.selectedNode === n.id
                        ? "direct"
                        : c.settings.selectedNode,
                    finalOutbound:
                      c.settings.finalOutbound === n.id
                        ? "select"
                        : c.settings.finalOutbound,
                  },
                })
              }
            />
          </div>
        ))}
      </section>
      {!snapshot.network ? (
        <EmptyState
          compact
          icon="network"
          title="正在读取网络状态"
          description="可使用右上角刷新重试。"
        />
      ) : (
        <>
          <Disclosure title="接口与地址">
            {snapshot.network.interfaces.map((i) => (
              <div className="detailrow" key={i.name}>
                <code>{i.name}</code>
                <span>{i.addresses.join(" · ")}</span>
              </div>
            ))}
          </Disclosure>
          <Disclosure title="外部软件">
            {snapshot.network.plugins.map((p) => (
              <div className="entry" key={p.id}>
                <strong>{p.name}</strong>
                <p>{p.detail}</p>
              </div>
            ))}
          </Disclosure>
          {snapshot.network.warnings.map((w) => (
            <p key={w} className="hint">
              {w}
            </p>
          ))}
        </>
      )}
    </>
  );
}
