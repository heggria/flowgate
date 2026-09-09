import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
export interface HttpEgressRoute {
  id: string;
  proxyUrl: string;
  allowedOrigins: readonly string[];
  configurationRevision: number;
  trustedCa?: string;
}
/** Every request uses the selected route; proxy errors never retry directly. */
export async function requestHttpEgress(
  route: HttpEgressRoute,
  target: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const url = new URL(target),
    proxy = new URL(route.proxyUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["http:", "https:", "socks5h:"].includes(proxy.protocol) ||
    url.username ||
    url.password ||
    proxy.username ||
    proxy.password ||
    !route.allowedOrigins.includes(url.origin) ||
    (route.trustedCa && route.trustedCa.length > 65536)
  )
    throw new Error("Egress target or protocol denied");
  signal.throwIfAborted();
  // Keep ordinary HTTP proxy request semantics, including for minimal HTTP proxies.
  const plain = url.protocol === "http:" && proxy.protocol === "http:";
  const agent = plain
    ? undefined
    : proxy.protocol === "socks5h:"
      ? new SocksProxyAgent(proxy, { timeout: 15000 })
      : new HttpsProxyAgent(proxy, {
          timeout: 15000,
          ...(route.trustedCa ? { ca: route.trustedCa } : {}),
        });
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(
      {
        protocol: plain ? "http:" : url.protocol,
        hostname: (plain ? proxy.hostname : url.hostname).replace(
          /^\[|\]$/g,
          "",
        ),
        port: plain
          ? proxy.port || 80
          : url.port || (url.protocol === "https:" ? 443 : 80),
        path: plain ? url.href : url.pathname + url.search,
        method: "GET",
        headers: { host: url.host },
        signal,
        timeout: 15000,
        agent: agent ?? false,
        ...(route.trustedCa ? { ca: route.trustedCa } : {}),
      },
      (response) => {
        response.once("close", () => agent?.destroy());
        resolve(response);
      },
    );
    outgoing.once("timeout", () =>
      outgoing.destroy(new Error("Egress timeout")),
    );
    outgoing.once("error", (error) => {
      agent?.destroy();
      reject(error);
    });
    outgoing.end();
  });
}
