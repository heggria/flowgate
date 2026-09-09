import { SearchField, Combobox, EmptyState } from "../components";
import { useState, useRef, useEffect, useId } from "react";
import type {
  TrafficSnapshot,
  FlowRecord,
  Configuration,
} from "../../../packages/contracts/src/index";
import { bytes, outboundName } from "../format";
import { Icon } from "../icons";
export function Traffic({
  traffic,
  compact = false,
  onExpand,
  configuration,
  detailPanels,
}: {
  configuration?: Configuration;
  detailPanels?: import("../modules").DetailPanelContribution[];
  traffic?: TrafficSnapshot;
  compact?: boolean;
  onExpand?: () => void;
}) {
  const [sort, setSort] = useState("recent");
  const name = (id: string) =>
    configuration?.nodes.find((node) => node.id === id)?.name ??
    configuration?.externalNetworks?.find((network) => network.id === id)
      ?.name ??
    outboundName(id);
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(false),
    [selected, setSelected] = useState<FlowRecord | null>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const inspectorId = useId();
  useEffect(() => {
    if (selected) {
      inspector.current?.scrollIntoView({ block: "nearest" });
      inspector.current?.focus({ preventScroll: true });
    }
  }, [selected?.id]);
  const closeDetails = () => {
    setSelected(null);
    returnFocus.current?.focus({ preventScroll: true });
  };
  const rows = (traffic?.flows ?? []).filter(
    (f) =>
      (!active || f.state === "active") &&
      `${f.target} ${f.outbound} ${name(f.outbound)} ${f.protocol}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  if (sort !== "recent")
    rows.sort((a, b) =>
      sort === "target"
        ? a.target.localeCompare(b.target)
        : sort === "download"
          ? b.download - a.download
          : b.upload - a.upload,
    );
  const current = traffic?.flows.find((f) => f.id === selected?.id) ?? selected;
  return (
    <section className="panel connectionpanel">
      <div className="paneltitle">
        <h2>
          {compact ? "最近连接" : "连接列表"}
          <span className="count">{rows.length}</span>
        </h2>
        {compact ? (
          <button className="textbutton" onClick={onExpand}>
            查看全部 <Icon name="chevron" size={13} />
          </button>
        ) : (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            仅活跃
          </label>
        )}
      </div>
      {!compact ? (
        <div className="tabletools">
          <SearchField
            label="搜索连接"
            placeholder="搜索域名、出口或协议"
            value={query}
            onChange={setQuery}
          />
          <Combobox
            label="连接排序"
            value={sort}
            options={[
              { value: "recent", label: "最近连接" },
              { value: "download", label: "下载量" },
              { value: "upload", label: "上传量" },
              { value: "target", label: "目标名称" },
            ]}
            onChange={setSort}
          />
        </div>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>目标</th>
              <th>出口</th>
              <th className="numeric">下载</th>
              <th className="numeric">上传</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, compact ? 5 : 200).map((f) => (
              <tr
                key={f.id}
                className={current?.id === f.id ? "selectedrow" : ""}
              >
                <td>
                  <button
                    className="targetbutton"
                    aria-expanded={current?.id === f.id}
                    aria-controls={
                      current?.id === f.id ? inspectorId : undefined
                    }
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setSelected(f);
                    }}
                  >
                    <i
                      className={f.state === "active" ? "dot online" : "dot"}
                    />
                    <span title={f.target}>{f.target}</span>
                  </button>
                  <small className="protocol">
                    {f.protocol.toUpperCase()} ·{" "}
                    {f.state === "active" ? "活跃" : "已结束"}
                  </small>
                </td>
                <td title={f.outbound}>{name(f.outbound)}</td>
                <td className="numeric">{bytes(f.download)}</td>
                <td className="numeric">{bytes(f.upload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length ? (
        <EmptyState
          compact
          icon="connections"
          title={query || active ? "没有匹配的连接" : "暂无连接"}
          description={
            query || active
              ? "调整筛选条件"
              : traffic?.available
                ? "等待应用流量经过代理"
                : "启动代理后，连接将在这里显示"
          }
        >
          {query || active ? (
            <button
              className="textbutton"
              onClick={() => {
                setQuery("");
                setActive(false);
              }}
            >
              清除筛选
            </button>
          ) : null}
        </EmptyState>
      ) : null}
      {current ? (
        <div
          className="inspector"
          id={inspectorId}
          ref={inspector}
          tabIndex={-1}
          aria-label="连接详情"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeDetails();
            }
          }}
        >
          <div className="paneltitle">
            <h2>连接详情</h2>
            <button
              className="iconbutton"
              aria-label="关闭连接详情"
              onClick={closeDetails}
            >
              <Icon name="close" />
            </button>
          </div>
          {configuration
            ? detailPanels?.map(({ id, Component }) => (
                <Component
                  key={id}
                  flow={current}
                  configuration={configuration}
                />
              ))
            : null}
        </div>
      ) : null}
    </section>
  );
}
