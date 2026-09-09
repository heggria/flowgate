import { requestHttpEgress, type HttpEgressRoute } from "./egress";
import type { Server } from "node:http";
import { DurableJobs, type JobDefinition } from "./jobs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { beforeDeadline } from "./deadline";
import { join } from "node:path";
import type {
  CapabilityManifest,
  ServiceLifecycle,
} from "../../contracts/src/index";
export class NamespacedStorage {
  private static queues = new Map<string, Promise<unknown>>();
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const namespace = join(this.root, this.packageId);
    const previous =
      NamespacedStorage.queues.get(namespace) ?? Promise.resolve();
    const result = previous.then(action);
    const settled = result.catch(() => {});
    NamespacedStorage.queues.set(namespace, settled);
    void settled.finally(() => {
      if (NamespacedStorage.queues.get(namespace) === settled)
        NamespacedStorage.queues.delete(namespace);
    });
    return result;
  }
  get<T>(key: string): Promise<T | null> {
    return this.exclusive(() => this.read<T>(key));
  }
  put(key: string, value: unknown) {
    return this.exclusive(() => this.write(key, value));
  }
  update<T>(key: string, change: (current: T | null) => T | Promise<T>) {
    return this.exclusive(async () => {
      const value = await change(await this.read<T>(key));
      await this.write(key, value);
      return value;
    });
  }
  async migrate<T>(
    key: string,
    target: number,
    steps: ReadonlyMap<number, (value: unknown) => unknown>,
  ) {
    if (!Number.isSafeInteger(target) || target < 1)
      throw new Error("Invalid storage schema");
    const envelope = await this.update<{ schema: number; value: unknown }>(
      key,
      (current) => {
        let schema = current?.schema ?? 0;
        let value: unknown = current?.value ?? null;
        if (!Number.isSafeInteger(schema) || schema < 0 || schema > target)
          throw new Error("Storage schema incompatible");
        while (schema < target) {
          const step = steps.get(schema + 1);
          if (!step) throw new Error("Storage migration missing");
          value = step(value);
          schema++;
        }
        return { schema, value };
      },
    );
    return envelope.value as T;
  }
  constructor(
    readonly root: string,
    readonly packageId: string,
  ) {
    if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(packageId))
      throw new Error("Invalid namespace");
  }
  private path(key: string) {
    if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(key))
      throw new Error("Invalid storage key");
    return join(this.root, this.packageId, key + ".json");
  }
  private async ensureDirectory() {
    const directory = join(this.root, this.packageId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(directory)).isDirectory() ||
      (await lstat(directory)).isSymbolicLink()
    )
      throw new Error("Invalid namespace directory");
  }
  private async read<T>(key: string): Promise<T | null> {
    try {
      await this.ensureDirectory();
      if ((await lstat(this.path(key))).isSymbolicLink())
        throw new Error("Storage links are not supported");
      return JSON.parse(await readFile(this.path(key), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  private async write(key: string, value: unknown) {
    const path = this.path(key);
    await this.ensureDirectory();
    const temp = path + "." + randomUUID() + ".tmp";
    const serialized = JSON.stringify(value);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized) > 4 * 1024 * 1024
    )
      throw new Error("Storage value exceeds limit");
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
      await file.close();
      await rename(temp, path);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}
export class CapabilityHost {
  private endpoints = new Map<string, Server>();
  private streams = new Map<string, AbortController>();
  async endpoint(id: string, server: Server): Promise<number> {
    this.require("endpoints");
    if (this.endpoints.has(id) || server.listening)
      throw new Error("Endpoint already registered");
    this.endpoints.set(id, server);
    server.once("close", () => this.endpoints.delete(id));
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off("listening", listening);
          reject(error);
        };
        const listening = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", listening);
        server.listen(0, "127.0.0.1");
      });
      if (this.draining || !this.active) {
        server.close();
        throw new Error("Endpoint startup canceled");
      }
      return (server.address() as { port: number }).port;
    } catch (error) {
      this.endpoints.delete(id);
      throw error;
    }
  }
  stream(id: string, controller = new AbortController()) {
    this.require("streams");
    if (this.streams.has(id)) throw new Error("Duplicate stream");
    this.streams.set(id, controller);
    return {
      signal: controller.signal,
      release: () => this.streams.delete(id),
    };
  }
  resources() {
    return {
      endpoints: [...this.endpoints.keys()],
      streams: this.streams.size,
    };
  }
  private durable?: DurableJobs;
  async durableJobs(
    storage: NamespacedStorage,
    definitions: ReadonlyMap<string, JobDefinition>,
  ) {
    this.require("jobs");
    this.require("storage");
    if (storage.packageId !== this.manifest.id || this.durable)
      throw new Error("Job namespace unavailable");
    const jobs = new DurableJobs(storage, definitions);
    await jobs.restore();
    this.require("jobs");
    this.durable = jobs;
    return jobs;
  }
  private jobs = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private services = new Map<string, ServiceLifecycle>();
  private starting = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private active = true;
  private draining = false;
  constructor(
    readonly manifest: CapabilityManifest,
    readonly allowedEgress: ReadonlySet<string>,
    readonly credentialRefs: ReadonlySet<string>,
    readonly resolveCredential: (reference: string) => Promise<string>,
    readonly resolveEgress?: (id: string) => Promise<HttpEgressRoute>,
  ) {}
  private require(capability: CapabilityManifest["capabilities"][number]) {
    if (
      !this.active ||
      this.draining ||
      !this.manifest.capabilities.includes(capability)
    )
      throw new Error("Capability denied: " + capability);
  }
  async service(id: string, service: ServiceLifecycle) {
    this.require("services");
    if (this.services.has(id) || this.starting.has(id))
      throw new Error("Duplicate service");
    const controller = new AbortController();
    const check = () => {
      if (controller.signal.aborted || this.draining || !this.active)
        throw new Error("Service startup canceled");
    };
    const done = Promise.resolve().then(async () => {
      try {
        check();
        await service.prepare(controller.signal);
        check();
        await service.start();
        check();
        if (!(await service.health())) throw new Error("Service health failed");
        check();
        this.services.set(id, service);
      } catch (error) {
        await beforeDeadline(
          service.stop(),
          Date.now() + 5000,
          "服务清理",
        ).catch(() => {});
        throw error;
      } finally {
        this.starting.delete(id);
      }
    });
    this.starting.set(id, { controller, done });
    return done;
  }
  job(id: string, action: (signal: AbortSignal) => Promise<void>) {
    this.require("jobs");
    if (this.jobs.has(id)) throw new Error("Duplicate job");
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => action(controller.signal))
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, { controller, done });
    done.catch(() => {});
    return { cancel: () => controller.abort(), done };
  }
  async credential<T>(reference: string, use: (secret: string) => Promise<T>) {
    this.require("credentials");
    if (!this.credentialRefs.has(reference))
      throw new Error("Credential scope denied");
    return use(await this.resolveCredential(reference));
  }
  egress(id: string) {
    this.require("egress");
    if (!this.allowedEgress.has(id)) throw new Error("Egress scope denied");
    return Object.freeze({ id, owner: this.manifest.id });
  }
  async requestEgress(id: string, target: string, signal: AbortSignal) {
    this.egress(id);
    if (!this.resolveEgress) throw new Error("Egress transport unavailable");
    const route = structuredClone(await this.resolveEgress(id));
    this.require("egress");
    if (route.id !== id) throw new Error("Egress resolution mismatch");
    return Object.assign(await requestHttpEgress(route, target, signal), {
      egress: Object.freeze({
        id: route.id,
        configurationRevision: route.configurationRevision,
      }),
    });
  }
  async drain(deadline: number) {
    this.draining = true;
    for (const entry of [...this.jobs.values(), ...this.starting.values()])
      entry.controller.abort();
    const tasks = [
      ...(this.durable ? [this.durable.drain(deadline)] : []),
      ...[...this.jobs.values(), ...this.starting.values()].map((entry) =>
        entry.done.catch(() => {}),
      ),
      ...[...this.services.values()].map((service) =>
        Promise.resolve().then(() => service.drain(deadline)),
      ),
    ];
    await beforeDeadline(Promise.all(tasks), deadline, "后台任务和服务");
  }
  async stop() {
    this.active = false;
    let failure: unknown;
    try {
      await this.drain(Date.now() + 5000);
    } catch (error) {
      failure = error;
    }
    const deadline = Date.now() + 5000;
    const results = await Promise.allSettled(
      [...this.services.values()].reverse().map((service) =>
        beforeDeadline(
          Promise.resolve().then(() => service.stop()),
          deadline,
          "服务停止",
        ),
      ),
    );
    this.services.clear();
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
    for (const endpoint of this.endpoints.values()) {
      endpoint.closeAllConnections();
      endpoint.close();
    }
    this.endpoints.clear();
    for (const result of results)
      if (result.status === "rejected") failure ??= result.reason;
    if (failure) throw failure;
  }
}
