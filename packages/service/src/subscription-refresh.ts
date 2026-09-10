import type { Subscription } from "../../contracts/src/index";

/** Service-owned, sequential refresh. No timers survive pause, drain or replacement. */
export class SubscriptionRefresh {
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private active?: Promise<void>;
  private attempted = new Map<string, number>();
  constructor(
    private readonly sources: () => Subscription[],
    private readonly refresh: (
      id: string,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly now = Date.now,
  ) {}
  start() {
    if (this.timer) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  async drain() {
    this.stop();
    await this.active;
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return Promise.resolve();
    const time = this.now();
    const current = this.sources();
    const ids = new Set(current.map((s) => s.id));
    for (const id of this.attempted.keys())
      if (!ids.has(id)) this.attempted.delete(id);
    const due = current
      .filter((source) => {
        if (!source.url || !source.refreshHours) return false;
        const elapsed = time - (Date.parse(source.updatedAt ?? "") || 0);
        return (
          elapsed >= source.refreshHours * 3600000 &&
          time - (this.attempted.get(source.id) ?? 0) >= 3600000
        );
      })
      .map((source) => source.id);
    this.active = (async () => {
      for (const id of due) {
        if (signal.aborted) break;
        // Source may have been removed or disabled while another refresh was in flight.
        if (!this.sources().some((s) => s.id === id && s.url && s.refreshHours))
          continue;
        this.attempted.set(id, this.now());
        try {
          await this.refresh(id, signal);
        } catch {
          /* The owner records a safe per-source status. */
        }
      }
    })().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
}
