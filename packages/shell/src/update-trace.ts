import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
export interface UpdateEvent {
  operationId: string;
  releaseSet: string;
  stage: string;
  at: string;
}
export class UpdateTrace {
  private events: UpdateEvent[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async init() {
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, "update-trace.json"), "utf8"),
      );
      if (Array.isArray(saved)) this.events = saved.slice(-100);
    } catch {
      this.events = [];
    }
  }
  record(event: UpdateEvent) {
    const task = this.queue.then(async () => {
      this.events.push(event);
      this.events = this.events.slice(-100);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, "update-trace.json");
      await writeFile(path + ".tmp", JSON.stringify(this.events), {
        mode: 0o600,
      });
      await rename(path + ".tmp", path);
    });
    this.queue = task.catch(() => {});
    return task;
  }
  snapshot() {
    return this.events.map((event) => ({ ...event }));
  }
}
