/** Callers authenticate epoch/session before invoking this registry. */
export class RequestScope {
  private requests = new Map<string, AbortController>();
  async run<T>(
    id: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.requests.has(id) || this.requests.size >= 128)
      throw new Error("请求重复或超过并发限制");
    const controller = new AbortController();
    this.requests.set(id, controller);
    try {
      return await action(controller.signal);
    } finally {
      this.requests.delete(id);
    }
  }
  cancel(id: string) {
    const controller = this.requests.get(id);
    controller?.abort(new Error("请求已取消"));
    return !!controller;
  }
  close() {
    for (const controller of this.requests.values()) controller.abort();
  }
}
