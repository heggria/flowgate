import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { NodeConfig } from "../../contracts/src/index";
import { validateNode } from "../../domain/src/configuration";
export function parseSubscription(
  text: string,
  sourceId?: string,
): NodeConfig[] {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw new Error("订阅超过 4 MB 限制");
  let nodes: NodeConfig[] = [];
  const input = text.trim();
  const make = (o: Record<string, unknown>): NodeConfig => ({
    id: randomUUID(),
    name: String(o.tag ?? o.name ?? o.server ?? "节点"),
    type:
      String(o.type) === "ss"
        ? "shadowsocks"
        : String(o.type) === "socks5"
          ? "socks"
          : (String(o.type) as NodeConfig["type"]),
    server: String(o.server ?? ""),
    port: Number(o.server_port ?? o.port),
    options: Object.fromEntries(
      Object.entries(o).filter(
        ([k]) =>
          !["tag", "name", "server", "server_port", "port", "type"].includes(k),
      ),
    ),
    sourceId,
  });
  if (input.startsWith("{") || input.startsWith("[")) {
    const data = JSON.parse(input);
    const entries = Array.isArray(data) ? data : data.outbounds;
    if (!Array.isArray(entries)) throw new Error("缺少 outbounds");
    nodes = entries
      .filter(
        (o: any) =>
          !["direct", "block", "selector", "urltest", "dns"].includes(o.type),
      )
      .map(make);
  } else if (/^proxies\s*:/m.test(input)) {
    const data = parseYaml(input, { maxAliasCount: 50 });
    if (!Array.isArray(data.proxies)) throw new Error("缺少 proxies");
    nodes = data.proxies.map((o: any) => {
      const n = make(o);
      if (n.type === "shadowsocks") n.options.method = o.cipher;
      if (n.type === "vmess") n.options.security = o.cipher ?? "auto";
      if (o.network && !["tcp", "ws", "grpc"].includes(o.network))
        throw new Error("暂不支持此 Clash 传输类型：" + o.network);
      if (o.network === "ws")
        n.options.transport = {
          type: "ws",
          path: o["ws-opts"]?.path ?? "/",
          headers: o["ws-opts"]?.headers ?? {},
        };
      if (o.network === "grpc")
        n.options.transport = {
          type: "grpc",
          service_name: o["grpc-opts"]?.["grpc-service-name"] ?? "",
        };
      if (o.tls || ["trojan", "hysteria2", "tuic"].includes(n.type))
        n.options.tls = {
          enabled: true,
          server_name: o.sni ?? o.servername ?? o.server,
        };
      if (o["alterId"] !== undefined) n.options.alter_id = o.alterId;
      return n;
    });
  } else {
    let lines = input;
    if (!input.includes("://"))
      lines = Buffer.from(input, "base64").toString("utf8");
    nodes = lines
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        if (line.startsWith("vmess://")) {
          const p = JSON.parse(
            Buffer.from(line.slice(8), "base64").toString("utf8"),
          );
          if (!["tcp", "ws", "grpc", undefined, ""].includes(p.net))
            throw new Error("不支持的 VMess 传输");
          return {
            id: randomUUID(),
            name: String(p.ps ?? p.add),
            type: "vmess" as const,
            server: String(p.add),
            port: Number(p.port),
            sourceId,
            options: {
              uuid: p.id,
              security: p.scy ?? "auto",
              alter_id: Number(p.aid ?? 0),
              ...(p.tls === "tls"
                ? {
                    tls: {
                      enabled: true,
                      server_name: p.sni || p.host || p.add,
                    },
                  }
                : {}),
              ...(p.net === "ws"
                ? {
                    transport: {
                      type: "ws",
                      path: p.path || "/",
                      headers: { Host: p.host || p.add },
                    },
                  }
                : {}),
              ...(p.net === "grpc"
                ? { transport: { type: "grpc", service_name: p.path || "" } }
                : {}),
            },
          };
        }
        const u = new URL(line);
        const type = u.protocol.slice(0, -1);
        const n: NodeConfig = {
          id: randomUUID(),
          name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
          type: (type === "ss"
            ? "shadowsocks"
            : type === "socks5"
              ? "socks"
              : type) as NodeConfig["type"],
          server: u.hostname,
          port:
            Number(u.port) ||
            (["http", "socks", "socks5"].includes(type) ? 1080 : 443),
          sourceId,
          options: {},
        };
        if (
          u.searchParams.get("security") &&
          !["tls", "none", "reality"].includes(u.searchParams.get("security")!)
        )
          throw new Error("不支持的 TLS 模式");
        if (type === "ss") {
          const auth = u.password
            ? decodeURIComponent(u.username) +
              ":" +
              decodeURIComponent(u.password)
            : u.username.includes(":")
              ? decodeURIComponent(u.username)
              : Buffer.from(
                  decodeURIComponent(u.username),
                  "base64",
                ).toString();
          const split = auth.indexOf(":");
          if (split < 1) throw new Error("无效 Shadowsocks 认证信息");
          n.options = {
            method: auth.slice(0, split),
            password: auth.slice(split + 1),
          };
        } else if (type === "trojan" || type === "hysteria2") {
          n.options = {
            password: decodeURIComponent(u.username),
            tls: {
              enabled: true,
              server_name: u.searchParams.get("sni") || u.hostname,
            },
          };
        } else if (type === "vless") {
          n.options = {
            uuid: u.username,
            tls: {
              enabled: ["tls", "reality"].includes(
                u.searchParams.get("security") ?? "",
              ),
              ...(u.searchParams.get("security") === "reality"
                ? {
                    reality: {
                      enabled: true,
                      public_key: u.searchParams.get("pbk"),
                      short_id: u.searchParams.get("sid") ?? "",
                    },
                    utls: {
                      enabled: true,
                      fingerprint: u.searchParams.get("fp") ?? "chrome",
                    },
                  }
                : {}),
              server_name: u.searchParams.get("sni") || u.hostname,
            },
            ...(u.searchParams.get("flow")
              ? { flow: u.searchParams.get("flow") }
              : {}),
          };
        } else {
          n.options = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
          };
        }
        const transport = u.searchParams.get("type");
        if (transport && transport !== "tcp") {
          if (transport === "ws")
            n.options.transport = {
              type: "ws",
              path: u.searchParams.get("path") || "/",
              headers: { Host: u.searchParams.get("host") || u.hostname },
            };
          else if (transport === "grpc")
            n.options.transport = {
              type: "grpc",
              service_name: u.searchParams.get("serviceName") || "",
            };
          else throw new Error("不支持的节点传输类型：" + transport);
        }
        return n;
      });
  }
  if (!nodes.length || nodes.length > 5000)
    throw new Error("订阅没有支持的节点或节点过多");
  nodes.forEach(validateNode);
  return nodes;
}
