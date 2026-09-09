import type { NetworkState } from "../../contracts/src/index";
/** Observes external state only; never takes ownership of another app's routes. */
export class NetworkObserver {
  private pending?: Promise<NetworkState>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private generation = 0;
  constructor(
    private readonly inspect: () => Promise<NetworkState>,
    private readonly publish: (state: NetworkState) => void,
    private readonly failed: () => void,
  ) {}
  refresh(): Promise<NetworkState> {
    if (this.stopped)
      return Promise.reject(new Error("Network observer stopped"));
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = Promise.resolve()
      .then(this.inspect)
      .then(
        (state) => {
          if (!this.stopped && generation === this.generation)
            this.publish(state);
          return state;
        },
        (error) => {
          if (!this.stopped && generation === this.generation) this.failed();
          throw error;
        },
      )
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
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
    this.generation++;
    this.pending = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  resume() {
    this.stopped = false;
    this.start();
  }
}
