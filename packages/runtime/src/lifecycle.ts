import type {
  CapabilityManifest,
  Lifecycle,
  TraceContext,
} from "../../contracts/src/index";
export interface TraceEvent {
  time: string;
  name: string;
  status: string;
  context: Partial<TraceContext>;
  detail?: string;
}
export class TraceBuffer {
  private events: TraceEvent[] = [];
  dropped = 0;
  onChange?: () => void;
  restore(events: TraceEvent[]) {
    this.events = structuredClone(events.slice(-this.capacity));
  }
  constructor(readonly capacity = 500) {}
  emit(
    name: string,
    status: string,
    context: Partial<TraceContext> = {},
    detail?: string,
  ) {
    if (this.events.length === this.capacity) {
      this.events.shift();
      this.dropped++;
    }
    this.events.push({
      time: new Date().toISOString(),
      name,
      status,
      context: structuredClone(context),
      detail,
    });
    this.onChange?.();
  }
  snapshot() {
    return structuredClone(this.events);
  }
}
export interface Contribution {
  owner?: { id: string; version: string; instance?: string };
  id: string;
  kind: "route" | "command" | "settings" | "detailPanel";
  value: unknown;
}
export interface RuntimeModule {
  manifest: CapabilityManifest;
  activate(context: {
    signal: AbortSignal;
    contribute(item: Contribution): void;
    defer(dispose: () => void | Promise<void>): void;
  }): Promise<void>;
}
export class ModuleRuntime {
  private active: {
    module: RuntimeModule;
    controller: AbortController;
    disposers: (() => void | Promise<void>)[];
    identity: Partial<TraceContext>;
  }[] = [];
  private contributions = new Map<string, Contribution>();
  status: Lifecycle = "stopped";
  constructor(
    readonly trace = new TraceBuffer(),
    private readonly context: () => Partial<TraceContext> = () => ({}),
  ) {}
  get entries() {
    return [...this.contributions.values()];
  }
  async activate(
    modules: RuntimeModule[],
    satisfiedDependencies: ReadonlySet<string> = new Set(),
  ) {
    if (this.active.length) throw new Error("Modules already active");
    const byId = new Map(modules.map((m) => [m.manifest.id, m]));
    if (byId.size !== modules.length) throw new Error("Duplicate module");
    const ordered: RuntimeModule[] = [],
      visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Module dependency cycle");
      if (visited.has(id)) return;
      const m = byId.get(id);
      if (!m && satisfiedDependencies.has(id)) return;
      if (!m) throw new Error("Missing dependency: " + id);
      if (m.manifest.api !== 1) throw new Error("Unsupported module API");
      visiting.add(id);
      m.manifest.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
      ordered.push(m);
    };
    modules.forEach((m) => visit(m.manifest.id));
    const staged = new Map<string, Contribution>();
    this.status = "starting";
    try {
      for (const module of ordered) {
        const entry = {
          module,
          controller: new AbortController(),
          disposers: [] as (() => void | Promise<void>)[],
          identity: {
            pluginInstance: module.manifest.id + ":" + crypto.randomUUID(),
            moduleVersions: { [module.manifest.id]: module.manifest.version },
          },
        };
        this.active.push(entry);
        this.trace.emit(module.manifest.id, "starting", {
          ...this.context(),
          ...entry.identity,
        });
        await module.activate({
          signal: entry.controller.signal,
          contribute: (c) => {
            if (staged.has(c.id)) throw new Error("Duplicate contribution");
            staged.set(c.id, {
              ...c,
              owner: {
                id: module.manifest.id,
                version: module.manifest.version,
                instance: entry.identity.pluginInstance,
              },
            });
          },
          defer: (d) => entry.disposers.push(d),
        });
        this.trace.emit(module.manifest.id, "ready", {
          ...this.context(),
          ...entry.identity,
        });
      }
      this.contributions = staged;
      this.status = "ready";
    } catch (error) {
      await this.stop();
      this.status = "failed";
      throw error;
    }
  }
  async stop() {
    this.status = "draining";
    const failures: unknown[] = [];
    for (const entry of this.active.reverse()) {
      this.trace.emit(entry.module.manifest.id, "draining", {
        ...this.context(),
        ...entry.identity,
      });
      entry.controller.abort();
      for (const dispose of entry.disposers.reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
          this.trace.emit(entry.module.manifest.id, "release-failed", {
            ...this.context(),
            ...entry.identity,
          });
        }
      }
      this.trace.emit(entry.module.manifest.id, "stopped", {
        ...this.context(),
        ...entry.identity,
      });
    }
    this.active = [];
    this.contributions.clear();
    this.status = "stopped";
    if (failures.length) {
      this.status = "failed";
      throw new AggregateError(failures, "Module resource release failed");
    }
  }
}
