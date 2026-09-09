import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import type { Snapshot } from "../core/types";
const exec = promisify(execFile);
export async function run(file: string, args: string[]): Promise<string> {
  const { stdout } = await exec(file, args, {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}
export function parseDns(text: string): Snapshot["dns"] {
  return text
    .split(/resolver #\d+/)
    .slice(1)
    .map((block) => ({
      domain:
        block.match(/^\s*domain\s*:\s*(.+)$/m)?.[1]?.trim() ??
        "默认 / 作用域解析器",
      servers: [...block.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map(
        (m) => m[1],
      ),
    }))
    .filter((r) => r.servers.length > 0);
}
export function parseSystemProxies(text: string) {
  const result: NonNullable<Snapshot["systemProxies"]> = [];
  for (const [key, kind] of [
    ["HTTP", "http"],
    ["HTTPS", "https"],
    ["SOCKS", "socks"],
  ] as const) {
    const enabled = new RegExp(
      "^\\s*" + key + "Enable\\s*:\\s*1\\s*$",
      "m",
    ).test(text);
    const host = text.match(
      new RegExp("^\\s*" + key + "Proxy\\s*:\\s*(\\S+)", "m"),
    )?.[1];
    const port = Number(
      text.match(new RegExp("^\\s*" + key + "Port\\s*:\\s*(\\d+)", "m"))?.[1],
    );
    if (enabled && host && !/[\s/@]/.test(host) && port > 0 && port <= 65535)
      result.push({ kind, host, port });
  }
  return result;
}
export async function inspectSystem(): Promise<Omit<Snapshot, "plugins">> {
  if (process.platform !== "darwin")
    throw new Error("当前版本仅支持 macOS 只读诊断");
  const commands: [string, string[]][] = [
    ["/sbin/route", ["-n", "get", "default"]],
    ["/usr/sbin/scutil", ["--proxy"]],
    ["/usr/sbin/scutil", ["--dns"]],
    ["/usr/sbin/netstat", ["-rn", "-f", "inet"]],
    ["/usr/sbin/netstat", ["-rn", "-f", "inet6"]],
  ];
  const results = await Promise.allSettled(
    commands.map(([file, args]) => run(file, args)),
  );
  const value = (i: number) =>
    results[i].status === "fulfilled"
      ? (results[i] as PromiseFulfilledResult<string>).value
      : "";
  const warnings = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [
          `${["默认路由", "系统代理", "DNS", "IPv4 路由表", "IPv6 路由表"][i]}读取失败或超时，状态未知`,
        ]
      : [],
  );
  const defaultInterface = value(0).match(/interface:\s*(\S+)/)?.[1] ?? null;
  if (defaultInterface?.startsWith("utun"))
    warnings.push(
      "默认 IPv4 路由指向隧道接口；接口名不能证明所有者，也不能单独证明 VPN 冲突。",
    );
  warnings.push(
    "路由快照不能读取所有系统过滤器策略；强制 VPN 的实际分流能力仍须通过请求验证。",
  );
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    interfaces: Object.entries(networkInterfaces()).map(([name, items]) => ({
      name,
      addresses: (items ?? []).map((i) => i.address),
      cidrs: (items ?? []).flatMap((i) => (i.cidr ? [i.cidr] : [])),
    })),
    defaultInterface,
    defaultGateway: value(0).match(/gateway:\s*(\S+)/)?.[1] ?? null,
    proxyEnabled:
      results[1].status === "rejected"
        ? null
        : /(?:HTTP|HTTPS|SOCKS|ProxyAutoConfig)Enable\s*:\s*1/.test(value(1)),
    systemProxies: parseSystemProxies(value(1)),
    pacEnabled: /ProxyAutoConfigEnable\s*:\s*1/.test(value(1)),
    ipv6Routes: value(4)
      .split("\n")
      .filter(
        (line) => line.trim() && !/^(Routing|Internet6|Destination)/.test(line),
      )
      .slice(0, 100),
    dns: parseDns(value(2)),
    routes: value(3)
      .split("\n")
      .filter((l) =>
        /^(default|0\/1|128\.0\/1|100\.|10\.|172\.|192\.168)/.test(l.trim()),
      )
      .slice(0, 60),
    warnings,
  };
}
