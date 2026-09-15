import { problems } from "./problems";
import type {
  AppSnapshot,
  FlowGateClient,
  ShellPort,
} from "../../contracts/src/index";
declare global {
  interface Window {
    flowgate: FlowGateClient;
    shell: ShellPort;
  }
}
const pending = new Set<string>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
export const pendingCount = () => pending.size;
export const subscribePending = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export async function cancelPending() {
  await Promise.all([...pending].map((id) => window.flowgate.cancel(id)));
}
export const client: FlowGateClient = {
  cancel: (operationId) => window.flowgate.cancel(operationId),
  async request<T = unknown>(
    method: string,
    payload?: unknown,
    operationId = crypto.randomUUID(),
  ) {
    const tracked = !["snapshot", "operation.get"].includes(method);
    if (tracked) {
      pending.add(operationId);
      changed();
    }
    try {
      const result = await window.flowgate.request<T>(
        method,
        payload,
        operationId,
      );
      problems.resolve(method);
      return result;
    } catch (error) {
      problems.report(method, error);
      throw error;
    } finally {
      if (tracked) {
        pending.delete(operationId);
        changed();
      }
    }
  },
  subscribe: (listener) => window.flowgate.subscribe(listener),
};
export function mutation(method: string, payload?: unknown) {
  return client.request<{ snapshot: AppSnapshot }>(
    method,
    payload,
    crypto.randomUUID(),
  );
}

export async function shellRequest<T = unknown>(
  method: Parameters<ShellPort["request"]>[0],
  payload?: unknown,
): Promise<T> {
  const quiet = ["ui.ready", "ui.trace", "ui.context"].includes(method);
  try {
    const result = await window.shell.request(method, payload);
    if (!quiet) problems.resolve(method);
    return result as T;
  } catch (error) {
    if (!quiet) problems.report(method, error);
    throw error;
  }
}
