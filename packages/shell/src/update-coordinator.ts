import { randomUUID } from "node:crypto";
import type { ReleaseSet } from "../../contracts/src/index";
import type { ReleaseManager } from "../../release/src/manager";
export interface UpdateHooks {
  uiOnly?(manifest: ReleaseSet): boolean;
  restoreUI?(): Promise<void>;
  preflight(directory: string, manifest: ReleaseSet): Promise<void>;
  safePoint?(): Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  start(directory: string, manifest: ReleaseSet): Promise<void>;
  restore(): Promise<void>;
  reloadUI(directory: string, manifest: ReleaseSet): Promise<void>;
}
export class UpdateCoordinator {
  private busy = false;
  constructor(
    readonly releases: ReleaseManager,
    readonly hooks: UpdateHooks,
    readonly trace: (event: {
      operationId: string;
      releaseSet: string;
      stage: string;
      at: string;
    }) => Promise<void> = async () => {},
  ) {}
  async activate(id: string) {
    if (this.busy) throw new Error("已有更新操作进行中");
    this.busy = true;
    const operationId = randomUUID();
    const stage = (stage: string) =>
      this.trace({
        operationId,
        releaseSet: id,
        stage,
        at: new Date().toISOString(),
      });
    await stage("verifying").catch(() => {});
    let stopped = false;
    let uiOnly = false;
    try {
      return await this.releases.activate(id, {
        preflight: async (d, m) => {
          await stage("preflight");
          await this.hooks.preflight(d, m);
          // Refuse before candidate activation/quarantine and before replacing
          // any live host when native effects have not reached a known result.
          if (!this.hooks.uiOnly?.(m)) await this.hooks.safePoint?.();
        },
        switch: async (d, m) => {
          uiOnly = this.hooks.uiOnly?.(m) ?? false;
          if (uiOnly) {
            await stage("ui-switch");
            await this.hooks.reloadUI(d, m);
            return;
          }
          await stage("draining");
          stopped = true; // Drain may partially stop admission before failing.
          await this.hooks.drain();
          await this.hooks.stop();
          await stage("service-switch");
          await this.hooks.start(d, m);
          await this.hooks.reloadUI(d, m);
        },
        rollback: async () => {
          await stage("rollback").catch(() => {});
          if (stopped) await this.hooks.restore();
          else if (uiOnly) await this.hooks.restoreUI?.();
        },
      });
    } catch (error) {
      await stage("failed").catch(() => {});
      throw error;
    } finally {
      await stage("finished").catch(() => {});
      this.busy = false;
    }
  }
}
