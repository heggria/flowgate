import type { NetworkState } from "../../contracts/src/index";
/** Observes external state only; never takes ownership of another app's routes. */
export class NetworkObserver {
  private pending?: Promise<NetworkState>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    private readonly inspect: () => Promise<NetworkState>,
    private readonly publish: (state: NetworkState) => void,
    private readonly failed: () => void,
  ) {}
  refresh(): Promise<NetworkState> {
    if (this.stopped)
      return Promise.reject(new Error("Network observer stopped"));
    if (this.pending) return this.pending;
    this.pending = Promise.resolve()
      .then(this.inspect)
      .then(
        (state) => {
          if (!this.stopped) this.publish(state);
          return state;
        },
        (error) => {
          if (!this.stopped) this.failed();
          throw error;
        },
      )
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  start(interval = 15000) {
    if (this.timer || this.stopped) return;
    const poll = () => {
      void this.refresh().catch(() => {});
    };
    poll();
    this.timer = setInterval(poll, interval);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
