import { EmptyState, TaskError as NetworkError } from "../components";
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
      <PageHeader
        title="网络环境"
        description="观察本机网络，将外部连接接入分流。"
      >
        <button className="primary" onClick={() => setAdding(true)}>
          ＋ 绑定网络
        </button>
      </PageHeader>
      <NetworkError message={draft.error} />
      <p>
        HTTP / SOCKS 外部代理可在节点页导入。已有网络接口可作为独立的 TCP / UDP
        出口。
        <button className="textbutton" onClick={() => navigate("nodes")}>
          前往导入外部代理 →
        </button>
      </p>
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
        <p role="status">
          系统正在使用 PAC。PAC
          会按目标动态选路，不能当作单一出口；本应用保留其设置，手动代理模式可独立使用。
        </p>
      ) : null}
      {(snapshot.network?.systemProxies?.length ?? 0) > 0 ? (
        <section className="panel">
          <h2>已观察的系统代理</h2>
          {snapshot.network!.systemProxies!.map((proxy) => (
            <div className="entry" key={proxy.kind}>
              <strong>
                {proxy.kind.toUpperCase()} · {proxy.host}:{proxy.port}
              </strong>
              <button
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
              </button>
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
          <section className="panel">
            <h2>接口与地址</h2>
            {snapshot.network.interfaces.map((i) => (
              <div className="detailrow" key={i.name}>
                <code>{i.name}</code>
                <span>{i.addresses.join(" · ")}</span>
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>外部软件</h2>
            {snapshot.network.plugins.map((p) => (
              <div className="entry" key={p.id}>
                <strong>{p.name}</strong>
                <p>{p.detail}</p>
              </div>
            ))}
          </section>
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
