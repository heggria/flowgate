import type {
  SubscriptionFetchResult,
  SubscriptionMetadata,
} from "../../../contracts/src/subscriptions";
import { SUBSCRIPTION_LIMITS } from "../../../contracts/src/subscriptions";

export function subscriptionMetadata(headers: Headers): SubscriptionMetadata {
  const result: SubscriptionMetadata = {};
  for (const part of (headers.get("subscription-userinfo") ?? "").split(";")) {
    const match = part.trim().match(/^(upload|download|total|expire)=(\d+)$/);
    if (match && Number.isSafeInteger(Number(match[2])))
      result[match[1] as "upload"] = Number(match[2]);
  }
  const interval = Number(headers.get("profile-update-interval"));
  if (Number.isFinite(interval) && interval >= 1 && interval <= 168)
    result.updateIntervalHours = interval;
  return result;
}
export async function fetchSubscription(
  payload: {
    url: string;
    version?: number;
    etag?: string;
    lastModified?: string;
  },
  signal: AbortSignal,
): Promise<string | SubscriptionFetchResult> {
  try {
    const u = new URL(payload.url);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
    const headers: Record<string, string> = {};
    for (const [key, value] of [
      ["If-None-Match", payload.etag],
      ["If-Modified-Since", payload.lastModified],
    ])
      if (value && value.length <= 1000 && !/[\r\n]/.test(value))
        headers[key!] = value;
    const response = await fetch(u, {
      headers,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(SUBSCRIPTION_LIMITS.fetchMs),
      ]),
      redirect: "error",
    });
    const result: SubscriptionFetchResult = {
      version: 2,
      status: response.status === 304 ? "not-modified" : "ok",
      metadata: subscriptionMetadata(response.headers),
    };
    for (const [header, key] of [
      ["etag", "etag"],
      ["last-modified", "lastModified"],
    ] as const) {
      const value = response.headers.get(header);
      if (value && value.length <= 1000 && !/[\r\n]/.test(value))
        result[key] = value;
    }
    if (
      response.status === 304 &&
      payload.version === 2 &&
      (payload.etag || payload.lastModified)
    )
      return result;
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > SUBSCRIPTION_LIMITS.bytes
    ) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > SUBSCRIPTION_LIMITS.bytes) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    result.text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return payload.version === 2 ? result : result.text;
  } catch {
    throw new Error(
      signal.aborted
        ? "订阅请求已取消"
        : "订阅请求失败：请检查 HTTPS 地址、网络或来源大小（上限 4 MB）",
    );
  }
}
