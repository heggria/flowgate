import type { AutoUpdater } from "electron";
import type { ApplicationUpdateState } from "../../contracts/src/index";

type Runtime = {
  updater: Pick<AutoUpdater, "on" | "setFeedURL" | "checkForUpdates">;
  isPackaged: () => boolean;
  onChange?: (state: ApplicationUpdateState) => void;
};
export class ApplicationUpdate {
  private status: ApplicationUpdateState;
  constructor(
    readonly feed: string | undefined,
    private readonly runtime: Runtime,
  ) {
    let configured = false;
    try {
      configured = new URL(feed ?? "").protocol === "https:";
    } catch {}
    this.status = {
      phase: "idle",
      configured,
      revision: 0,
      message: configured ? "尚未检查完整应用更新" : "未配置应用更新源",
    };
    runtime.updater.on("error", () => {
      if (this.active) this.set("failed", "应用更新失败，当前版本保留");
    });
    runtime.updater.on("update-not-available", () => {
      if (this.status.phase === "checking")
        this.set("current", "当前应用已是最新版本");
    });
    runtime.updater.on("update-available", () => {
      if (this.status.phase === "checking")
        this.set("downloading", "正在下载完整应用更新");
    });
    runtime.updater.on("update-downloaded", () => {
      if (this.active) this.set("ready", "完整应用更新已下载，下次启动时安装");
    });
  }
  private get active() {
    return (
      this.status.phase === "checking" || this.status.phase === "downloading"
    );
  }
  private set(phase: ApplicationUpdateState["phase"], message: string) {
    this.status = {
      ...this.status,
      phase,
      message,
      revision: this.status.revision + 1,
    };
    this.runtime.onChange?.(this.state);
  }
  get state(): ApplicationUpdateState {
    return { ...this.status };
  }
  check() {
    // Electron's updater is process-global and downloads automatically. Starting
    // it twice can duplicate downloads; a ready update must remain ready.
    if (this.active || this.status.phase === "ready")
      return this.status.message;
    if (!this.status.configured) {
      this.set("failed", "未配置已签名的完整应用更新源");
      throw new Error(this.status.message);
    }
    if (!this.runtime.isPackaged()) {
      this.set("failed", "完整应用更新需要已签名的安装包");
      throw new Error(this.status.message);
    }
    this.set("checking", "正在检查应用更新");
    try {
      this.runtime.updater.setFeedURL({ url: this.feed!, serverType: "json" });
      this.runtime.updater.checkForUpdates();
    } catch {
      this.set("failed", "应用更新失败，当前版本保留");
      throw new Error(this.status.message);
    }
    return this.status.message;
  }
}
