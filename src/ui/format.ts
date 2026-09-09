export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i =
    value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
export const kernelLabels = {
  running: "运行中",
  stopped: "未启动",
  starting: "启动中",
  failed: "启动失败",
  unknown: "状态未知",
};
export const modeLabels = {
  manual: "手动代理",
  system: "系统代理",
  tun: "TUN",
};
export function outboundName(id: string) {
  return id === "direct"
    ? "直连"
    : id === "proxy"
      ? "代理"
      : id === "block"
        ? "拦截"
        : id || "未知";
}
