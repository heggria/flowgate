/** Presentation-safe failures. Never keep request payloads, URLs or credentials. */
export function safeMessage(value: unknown): string {
  return (value instanceof Error ? value.message : String(value ?? "操作失败"))
    .replace(
      /^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/,
      "",
    )
    .replace(
      /\b(?:https?|socks5?h?|ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic):\/\/[^\s<>"']+/gi,
      "[地址已隐藏]",
    )
    .replace(/(bearer\s+)[\w.\-]+/gi, "$1[已隐藏]")
    .replace(
      /((?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[已隐藏]",
    )
    .slice(0, 1600);
}
export type RecoveryTarget = "settings" | "nodes" | "network" | "activity";
export interface ProblemAdvice {
  code: string;
  title: string;
  guidance: string;
  target: RecoveryTarget;
  label: string;
  approval?: boolean;
}
export function adviseFailure(value: unknown): ProblemAdvice {
  const m = safeMessage(value);
  if (/HELPER_UNSIGNED|Developer ID|开发签名|未签名/.test(m))
    return {
      code: "HELPER_UNSIGNED",
      title: "当前版本无法安装系统辅助服务",
      guidance:
        "打开设置安装或更新本机辅助服务，并按系统提示批准管理员权限。也可先选择手动代理。",
      target: "settings",
      label: "查看网络接入",
    };
  if (/HELPER_BUNDLE|-67028|Codesigning failure|BadBundleFormat/.test(m))
    return {
      code: "HELPER_BUNDLE",
      title: "应用包校验失败",
      guidance:
        "辅助服务的应用包或签名不完整，请使用修复后的完整应用。重复批准权限无法修复此问题；可先选择手动代理。",
      target: "settings",
      label: "查看网络接入",
    };
  if (/HELPER_APPROVAL|等待.*批准|requiresApproval/.test(m))
    return {
      code: "HELPER_APPROVAL",
      title: "等待系统批准辅助服务",
      guidance:
        "打开设置重新安装或更新本机辅助服务，按系统提示批准管理员权限，再刷新状态。",
      target: "settings",
      label: "查看辅助服务",
      approval: true,
    };
  if (/状态未知|会话失联|unknown|ownership|所有权|恢复未完成/i.test(m))
    return {
      code: "STATE_UNKNOWN",
      title: "连接状态尚未确认",
      guidance:
        "先刷新网络状态并查看操作记录，确认上次操作的结果后再继续，避免重复修改系统设置。",
      target: "network",
      label: "检查网络环境",
    };
  if (/辅助服务|helper|system control/i.test(m))
    return {
      code: "HELPER_UNAVAILABLE",
      title: "系统辅助服务不可用",
      guidance:
        "打开设置查看辅助服务状态，根据提示安装或批准。也可明确选择手动代理模式后启动。",
      target: "settings",
      label: "查看辅助服务",
    };
  if (/EADDRINUSE|address already in use|端口.*占用/i.test(m))
    return {
      code: "PORT_IN_USE",
      title: "本地端口被占用",
      guidance: "在设置中更换本地监听端口并保存，再启动代理。",
      target: "settings",
      label: "修改本地端口",
    };
  if (/订阅|subscription|节点|outbound/i.test(m))
    return {
      code: "RESOURCE",
      title: "代理资源需要检查",
      guidance:
        "检查订阅和所选出口是否有效。更新失败时先查看保留的节点，不要重复导入。",
      target: "nodes",
      label: "检查节点与订阅",
    };
  if (/配置|configuration|DNS|invalid|校验/i.test(m))
    return {
      code: "CONFIGURATION",
      title: "配置未通过检查",
      guidance: "根据详情修正配置后保存，再启动代理。",
      target: "settings",
      label: "检查设置",
    };
  if (/timeout|timed out|超时|ECONN|网络|离线/i.test(m))
    return {
      code: "NETWORK",
      title: "网络请求未完成",
      guidance:
        "检查网络与外部代理状态。超时不代表操作一定未执行，请先确认当前状态。",
      target: "network",
      label: "检查网络环境",
    };
  if (/取消|cancel/i.test(m))
    return {
      code: "CANCELLED",
      title: "操作已取消",
      guidance: "更改是否生效以当前状态和操作记录为准；输入内容仍可继续编辑。",
      target: "activity",
      label: "查看操作记录",
    };
  return {
    code: "UNEXPECTED",
    title: "操作未完成",
    guidance: "展开详情查看具体原因。可前往操作记录检查结果和服务诊断。",
    target: "activity",
    label: "查看操作记录",
  };
}
export interface Problem {
  id: string;
  method: string;
  message: string;
  time: string;
  count: number;
  resolved: boolean;
  dismissed: boolean;
}
export function createProblemStore() {
  let items: Problem[] = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => items,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report(method: string, value: unknown) {
      const message = safeMessage(value);
      const previous = items.find(
        (p) => p.method === method && p.message === message && !p.resolved,
      );
      const next: Problem = {
        id: previous?.id ?? crypto.randomUUID(),
        method,
        message,
        time: new Date().toISOString(),
        count: (previous?.count ?? 0) + 1,
        resolved: false,
        dismissed: false,
      };
      items = [next, ...items.filter((p) => p.id !== next.id)].slice(0, 30);
      notify();
    },
    resolve(method: string, before?: string) {
      if (!items.some((p) => p.method === method && !p.resolved)) return;
      items = items.map((p) =>
        p.method === method && (!before || p.time <= before)
          ? { ...p, resolved: true }
          : p,
      );
      notify();
    },
    dismiss(id: string) {
      items = items.map((p) => (p.id === id ? { ...p, dismissed: true } : p));
      notify();
    },
  };
}
export const problems = createProblemStore();
export function navigateToRecovery(target: RecoveryTarget) {
  window.dispatchEvent(
    new CustomEvent("flowgate:recovery-navigate", { detail: target }),
  );
}

/** Service operations survive renderer restarts, including unattended auto-connect. */
export function createSnapshotProblemObserver(
  store: ReturnType<typeof createProblemStore>,
) {
  const seen = new Map<string, string>();
  const reportOnce = (method: string, message: string) => {
    if (
      !store
        .snapshot()
        .some(
          (p) =>
            p.method === method &&
            p.message === safeMessage(message) &&
            !p.resolved,
        )
    )
      store.report(method, message);
  };
  return (
    snapshot: Pick<
      import("../../contracts/src/index").AppSnapshot,
      "operations" | "kernel"
    >,
  ) => {
    const latest = new Map<string, (typeof snapshot.operations)[number]>();
    for (const operation of snapshot.operations) {
      const previous = latest.get(operation.kind);
      if (!previous || operation.startedAt > previous.startedAt)
        latest.set(operation.kind, operation);
    }
    for (const operation of latest.values()) {
      const signature = `${operation.id}:${operation.state}:${operation.message ?? ""}`;
      if (seen.get(operation.kind) === signature) continue;
      seen.set(operation.kind, signature);
      if (operation.state === "failed" || operation.state === "unknown") {
        reportOnce(
          operation.kind,
          operation.message ||
            (operation.state === "unknown"
              ? "操作状态未知，请检查操作记录"
              : "操作失败，请检查操作记录"),
        );
      } else if (operation.state === "succeeded") {
        store.resolve(
          operation.kind,
          operation.completedAt ?? operation.startedAt,
        );
      }
    }
    const { status, message } = snapshot.kernel;
    if (status === "failed" || status === "unknown")
      reportOnce(
        "kernel.state",
        message ||
          (status === "unknown"
            ? "连接状态未知"
            : "代理启动失败，请检查操作记录"),
      );
    else if (status === "running" || status === "stopped")
      store.resolve("kernel.state");
  };
}
export const observeSnapshotProblems = createSnapshotProblemObserver(problems);
