import { createServer, request } from "node:http";
import { Readable } from "node:stream";
import { connect } from "node:net";
export async function egressFixture() {
  const metrics = {
    upstreamRequests: 0,
    proxyRequests: 0,
    upstreamAborts: 0,
    online: true,
  };
  const upstream = createServer((_req, res) => {
    metrics.upstreamRequests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const stream = Readable.from(
      (async function* () {
        for (let i = 0; i < 2000; i++) {
          yield "data: " +
            JSON.stringify({ type: "upstream.delta", data: "u".repeat(8192) }) +
            "\n\n";
          await new Promise((r) => setTimeout(r, 1));
        }
      })(),
    );
    res.on("close", () => {
      if (!res.writableEnded) metrics.upstreamAborts++;
      stream.destroy();
    });
    stream.pipe(res);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = createServer((req, res) => {
    metrics.proxyRequests++;
    if (!metrics.online) {
      res.writeHead(502).end("selected proxy unavailable");
      return;
    }
    const outgoing = request(req.url, { headers: req.headers }, (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    });
    outgoing.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => outgoing.destroy());
    req.pipe(outgoing);
  });
  proxy.on("connect", (req, client, head) => {
    metrics.proxyRequests++;
    if (!metrics.online || req.url !== `127.0.0.1:${upstream.address().port}`) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const tunnel = connect(upstream.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) tunnel.write(head);
      client.pipe(tunnel);
      tunnel.pipe(client);
    });
    client.on("error", () => tunnel.destroy());
    client.on("close", () => tunnel.destroy());
    tunnel.on("error", () => client.destroy());
    tunnel.on("close", () => client.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${upstream.address().port}/stream`,
    proxyPort: proxy.address().port,
    metrics,
    async close() {
      for (const server of [proxy, upstream]) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    },
  };
}
