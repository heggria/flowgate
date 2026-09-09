import { app, autoUpdater } from "electron";
export class ApplicationUpdate {
  private status = "未配置应用更新源";
  constructor(readonly feed?: string) {
    autoUpdater.on("error", () => {
      this.status = "应用更新失败，当前版本保留";
    });
    autoUpdater.on("update-not-available", () => {
      this.status = "当前应用已是最新版本";
    });
    autoUpdater.on("update-available", () => {
      this.status = "正在下载完整应用更新";
    });
    autoUpdater.on("update-downloaded", () => {
      this.status = "完整应用更新已下载，下次退出后可安装";
    });
  }
  get state() {
    return this.status;
  }
  check() {
    if (!this.feed || !this.feed.startsWith("https://"))
      throw new Error("未配置已签名的完整应用更新源");
    if (!app.isPackaged) throw new Error("完整应用更新需要已签名的安装包");
    autoUpdater.setFeedURL({ url: this.feed, serverType: "json" });
    this.status = "正在检查应用更新";
    autoUpdater.checkForUpdates();
    return this.status;
  }
}
