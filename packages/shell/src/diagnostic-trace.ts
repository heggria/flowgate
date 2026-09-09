import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TraceBuffer } from "../../runtime/src/lifecycle";
export class DiagnosticTrace {
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly trace: TraceBuffer,
  ) {}
  async init() {
    const path = join(this.directory, "calls.json");
    try {
      if ((await stat(path)).size <= 2 * 1024 * 1024) {
        const events = JSON.parse(await readFile(path, "utf8"));
        if (
          Array.isArray(events) &&
          events.every(
            (event) =>
              event &&
              typeof event.time === "string" &&
              typeof event.name === "string" &&
              typeof event.status === "string" &&
              event.context &&
              typeof event.context === "object",
          )
        )
          this.trace.restore(events);
      }
    } catch {
      /* Diagnostic corruption must not prevent recovery. */
    }
    this.trace.onChange = () => {
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush().catch(() => {});
        }, 250);
    };
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.trace.snapshot();
    const task = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "calls.json");
      await writeFile(path + ".tmp", JSON.stringify(snapshot), { mode: 0o600 });
      await rename(path + ".tmp", path);
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
