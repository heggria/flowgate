import { Button } from "../components";
import { useState, useEffect, useRef } from "react";
import type { TrafficSnapshot } from "../../../packages/contracts/src/index";
import { bytes } from "../format";
export function TrafficChart({
  traffic,
  running,
}: {
  traffic?: TrafficSnapshot;
  running: boolean;
}) {
  const [range, setRange] = useState(60),
    [cursor, setCursor] = useState<number | null>(null);
  const frame = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(744);
  useEffect(() => {
    const svg = frame.current;
    if (!svg) return;
    const resize = new ResizeObserver(([entry]) =>
      setWidth(Math.max(300, entry.contentRect.width)),
    );
    resize.observe(svg);
    return () => resize.disconnect();
  }, []);
  const right = width - 16;
  const end = traffic?.sampledAt ?? Date.now(),
    start = end - range * 1000;
  const points = (traffic?.history ?? []).filter((p) => p.at >= start);
  const maximum = Math.max(
    1024,
    ...points.flatMap((p) => [p.uploadRate ?? 0, p.downloadRate ?? 0]),
  );
  const ceiling = 2 ** Math.ceil(Math.log2(maximum));
  const x = (at: number) => 48 + ((at - start) / (range * 1000)) * (right - 48);
  const y = (v: number) => 166 - (v / ceiling) * 140;
  function path(key: "uploadRate" | "downloadRate") {
    let pen = false,
      last = 0;
    return points
      .map((p) => {
        const value = p[key];
        if (value === null) {
          pen = false;
          return "";
        }
        const move = !pen || p.at - last > 5000;
        pen = true;
        last = p.at;
        return `${move ? "M" : "L"}${x(p.at).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .join(" ");
  }
  const selected =
    cursor === null
      ? null
      : points.reduce<(typeof points)[number] | null>(
          (best, p) =>
            !best || Math.abs(p.at - cursor) < Math.abs(best.at - cursor)
              ? p
              : best,
          null,
        );
  return (
    <section className="panel chartpanel">
      <div className="paneltitle">
        <h2>流量趋势</h2>
        <div className="segmented" aria-label="图表时间范围">
          {[60, 300, 600].map((s) => (
            <Button
              key={s}
              aria-pressed={range === s}
              onClick={() => {
                setRange(s);
                setCursor(null);
              }}
            >
              {s / 60} 分钟
            </Button>
          ))}
        </div>
      </div>
      <div className="chartlegend">
        <span>
          <i className="linekey download" />
          下载
        </span>
        <span>
          <i className="linekey upload" />
          上传
        </span>
        <small>
          {selected
            ? `${new Date(selected.at).toLocaleTimeString()}　↓ ${bytes(selected.downloadRate)}/s　↑ ${bytes(selected.uploadRate)}/s`
            : "速率 · B/s"}
        </small>
      </div>
      <svg
        className="trafficchart"
        ref={frame}
        viewBox={`0 0 ${width} 198`}
        role="img"
        aria-label={`最近 ${range / 60} 分钟上传和下载速率，${points.length} 个采样点`}
        tabIndex={0}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setCursor(
            start +
              Math.max(
                0,
                Math.min(
                  1,
                  (((e.clientX - r.left) / r.width) * width - 48) /
                    (right - 48),
                ),
              ) *
                range *
                1000,
          );
        }}
        onMouseLeave={() => setCursor(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setCursor((v) =>
              Math.max(
                start,
                Math.min(
                  end,
                  (v ?? end) + (e.key === "ArrowLeft" ? -1000 : 1000),
                ),
              ),
            );
          }
        }}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1="48"
              x2={right}
              y1={y(ceiling * f)}
              y2={y(ceiling * f)}
              className="gridline"
            />
            <text x="39" y={y(ceiling * f) + 4} textAnchor="end">
              {bytes(ceiling * f)}
            </text>
          </g>
        ))}
        <path d={path("downloadRate")} className="chartline download" />
        <path
          d={path("uploadRate")}
          className="chartline upload"
          strokeDasharray="4 3"
        />
        {selected ? (
          <line
            x1={x(selected.at)}
            x2={x(selected.at)}
            y1="22"
            y2="166"
            className="crosshair"
          />
        ) : null}
        <text x="48" y="190">
          −{range / 60} 分钟
        </text>
        <text x={(48 + right) / 2} y="190" textAnchor="middle">
          −{range / 120} 分钟
        </text>
        <text x={right} y="190" textAnchor="end">
          现在
        </text>
      </svg>
      {!traffic?.available || points.length < 2 ? (
        <div className="chartempty">
          {!running
            ? "启动代理后开始记录"
            : traffic?.available
              ? "正在采样"
              : "等待流量数据"}
        </div>
      ) : null}
    </section>
  );
}
