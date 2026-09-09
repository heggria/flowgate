import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Configuration, Operation } from "../../contracts/src/index";
import {
  initialConfiguration,
  validateConfiguration,
} from "../../domain/src/configuration";
export async function atomicWrite(path: string, value: unknown) {
  const tmp = path + ".tmp";
  const f = await open(tmp, "w", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
  await rename(tmp, path);
}
export class StateStore {
  configuration = initialConfiguration();
  operations: Operation[] = [];
  private lock?: Awaited<ReturnType<typeof open>>;
  private queue: Promise<unknown> = Promise.resolve();
  private accepting = true;
  constructor(
    readonly directory: string,
    readonly epoch: number,
  ) {}
  async start(readonly = false) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!readonly) {
      this.lock = await open(join(this.directory, "writer.lock"), "wx", 0o600);
      await this.lock.writeFile(
        JSON.stringify({ pid: process.pid, epoch: this.epoch }),
      );
      await this.lock.sync();
    }
    try {
      const data = JSON.parse(
        await readFile(join(this.directory, "state.json"), "utf8"),
      );
      validateConfiguration(data.configuration);
      this.configuration = data.configuration;
      this.operations = data.operations ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.close();
        throw e;
      }
    }
    // An interrupted operation has an unknown result until native reconciliation.
    this.operations = this.operations.map((o) =>
      o.state === "pending" ? { ...o, state: "unknown" } : o,
    );
  }
  async persist() {
    if (!this.lock) throw new Error("No writer lease");
    await atomicWrite(join(this.directory, "state.json"), {
      configuration: this.configuration,
      operations: this.operations.slice(-200),
    });
  }
  transact<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("服务正在排空"));
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async drain() {
    this.accepting = false;
    await this.queue;
  }
  resume() {
    if (!this.lock) throw new Error("No writer lease");
    this.accepting = true;
  }
  async close() {
    await this.drain();
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(join(this.directory, "writer.lock"));
    }
  }
}
