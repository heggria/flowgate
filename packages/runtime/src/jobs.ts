import { randomUUID } from "node:crypto";
import { beforeDeadline } from "./deadline";
import type { NamespacedStorage } from "./capabilities";
export interface JobRecord {
  id: string;
  kind: string;
  state: "paused" | "running" | "succeeded" | "failed" | "canceled" | "unknown";
  checkpoint: unknown;
  updatedAt: string;
}
export interface JobDefinition {
  /** Resume must be idempotent from the last durable checkpoint. */
  resumable: boolean;
  run(context: {
    signal: AbortSignal;
    checkpoint: unknown;
    save(value: unknown): Promise<void>;
  }): Promise<void>;
}
export class DurableJobs {
  private records: JobRecord[] = [];
  private running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private draining = false;
  constructor(
    private storage: NamespacedStorage,
    private definitions: ReadonlyMap<string, JobDefinition>,
  ) {}
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private persist() {
    return this.storage.put("jobs", { schema: 1, records: this.records });
  }
  async restore() {
    if (this.running.size || this.records.length)
      throw new Error("Jobs already initialized");
    const saved = await this.storage.get<{
      schema: number;
      records: JobRecord[];
    }>("jobs");
    if (!saved) return;
    if (
      saved.schema !== 1 ||
      !Array.isArray(saved.records) ||
      saved.records.length > 1000
    )
      throw new Error("Unsupported jobs state");
    const ids = new Set<string>();
    for (const record of saved.records) {
      if (
        !record ||
        typeof record.id !== "string" ||
        ids.has(record.id) ||
        typeof record.kind !== "string" ||
        ![
          "paused",
          "running",
          "succeeded",
          "failed",
          "canceled",
          "unknown",
        ].includes(record.state)
      )
        throw new Error("Invalid job record");
      ids.add(record.id);
      if (record.state === "running")
        record.state = this.definitions.get(record.kind)?.resumable
          ? "paused"
          : "unknown";
    }
    this.records = saved.records;
    await this.persist();
  }
  snapshot() {
    return structuredClone(this.records);
  }
  async create(kind: string, checkpoint: unknown = null) {
    return this.exclusive(async () => {
      if (this.draining || !this.definitions.has(kind))
        throw new Error("Job unavailable");
      if (this.records.length >= 1000)
        throw new Error("Job history limit reached");
      const record: JobRecord = {
        id: randomUUID(),
        kind,
        state: "paused",
        checkpoint,
        updatedAt: new Date().toISOString(),
      };
      this.records.push(record);
      try {
        await this.persist();
      } catch (error) {
        this.records.pop();
        throw error;
      }
      return record.id;
    });
  }
  async resume(id: string) {
    await this.exclusive(async () => {
      const record = this.records.find((r) => r.id === id);
      if (
        this.draining ||
        !record ||
        record.state !== "paused" ||
        this.running.has(id)
      )
        throw new Error("Job cannot resume");
      const definition = this.definitions.get(record.kind);
      if (!definition) throw new Error("Job definition unavailable");
      record.state = "running";
      try {
        await this.persist();
      } catch (error) {
        record.state = "paused";
        throw error;
      }
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() =>
          definition.run({
            signal: controller.signal,
            checkpoint: structuredClone(record.checkpoint),
            save: (value) =>
              this.exclusive(async () => {
                if (controller.signal.aborted || record.state !== "running")
                  throw new Error("Job interrupted");
                const previous = record.checkpoint;
                record.checkpoint = structuredClone(value);
                record.updatedAt = new Date().toISOString();
                try {
                  await this.persist();
                } catch (error) {
                  record.checkpoint = previous;
                  throw error;
                }
              }),
          }),
        )
        .then(
          () => this.finish(record, "succeeded"),
          () => this.finish(record, "failed"),
        )
        .finally(() => this.running.delete(id));
      this.running.set(id, { controller, done });
      done.catch(() => {});
    });
  }
  private finish(record: JobRecord, state: "succeeded" | "failed") {
    return this.exclusive(async () => {
      if (record.state === "running") record.state = state;
      record.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }
  async interrupt(
    id: string,
    mode: "pause" | "cancel",
    deadline = Date.now() + 5000,
  ) {
    let pending: Promise<void> | undefined;
    await this.exclusive(async () => {
      const record = this.records.find((r) => r.id === id);
      if (!record || !["running", "paused"].includes(record.state))
        throw new Error("Job cannot interrupt");
      if (mode === "pause" && !this.definitions.get(record.kind)?.resumable)
        throw new Error("Job does not support pause");
      const active = this.running.get(id);
      record.state = mode === "pause" ? "paused" : "canceled";
      active?.controller.abort();
      await this.persist();
      pending = active?.done;
    });
    if (pending) await beforeDeadline(pending, deadline, "任务暂停");
  }
  async drain(deadline: number) {
    this.draining = true;
    const results = await Promise.allSettled(
      [...this.running.keys()].map((id) => {
        const record = this.records.find((r) => r.id === id)!;
        return this.interrupt(
          id,
          this.definitions.get(record.kind)?.resumable ? "pause" : "cancel",
          deadline,
        );
      }),
    );
    const error = results.find((result) => result.status === "rejected");
    if (error?.status === "rejected") throw error.reason;
    await beforeDeadline(this.queue, deadline, "任务状态保存");
  }
}
