export interface TimerTicket {
  cancel(): void;
}
export class PausableTimers {
  private paused = false;
  private entries = new Set<{
    callback: () => void;
    remaining: number;
    deadline: number;
    handle?: ReturnType<typeof setTimeout>;
  }>();
  constructor(
    private readonly now = () => performance.now(),
    private readonly schedule = setTimeout,
    private readonly clear = clearTimeout,
  ) {}
  timeout(callback: () => void, delay: number): TimerTicket {
    const entry = {
      callback,
      remaining: delay,
      deadline: this.now() + delay,
    } as {
      callback: () => void;
      remaining: number;
      deadline: number;
      handle?: ReturnType<typeof setTimeout>;
    };
    this.entries.add(entry);
    if (!this.paused) this.arm(entry);
    return {
      cancel: () => {
        if (entry.handle) this.clear(entry.handle);
        this.entries.delete(entry);
      },
    };
  }
  private arm(entry: {
    callback: () => void;
    remaining: number;
    deadline: number;
    handle?: ReturnType<typeof setTimeout>;
  }) {
    entry.deadline = this.now() + entry.remaining;
    entry.handle = this.schedule(() => {
      this.entries.delete(entry);
      entry.callback();
    }, entry.remaining);
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    for (const entry of this.entries) {
      entry.remaining = Math.max(0, entry.deadline - this.now());
      if (entry.handle) this.clear(entry.handle);
      entry.handle = undefined;
    }
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const entry of this.entries) this.arm(entry);
  }
}
