import { BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export class DesktopShell {
  private readyResolve?: () => void;
  markReady() {
    this.readyResolve?.();
    this.readyResolve = undefined;
  }
  window?: BrowserWindow;
  private tray?: Tray;
  private rendererFailures = 0;
  quitting = false;
  recovering = false;
  constructor(
    readonly bundle: string,
    public uiPath: string,
    readonly actions: { quit: () => void; disconnect: () => void },
  ) {}
  authorize(event: Electron.IpcMainInvokeEvent) {
    if (
      !this.window ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== this.window.webContents.mainFrame ||
      event.senderFrame.url.split("#")[0] !== pathToFileURL(this.uiPath).href
    )
      throw new Error("无效调用来源");
  }
  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 960,
      minHeight: 650,
      backgroundColor: "#faf9f6",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: join(this.bundle, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_w, _p, cb) =>
      cb(false),
    );
    window.on("close", (e) => {
      if (!this.quitting) {
        e.preventDefault();
        window.hide();
      }
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (
        !this.quitting &&
        this.window === window &&
        details.reason !== "clean-exit"
      ) {
        this.rendererFailures++;
        if (this.rendererFailures > 3) this.recovery();
        else {
          // Recreate WebContents as well as the page: the crashed transport can
          // retain pending IPC/debugger state even after a navigation.
          this.window = undefined;
          window.destroy();
          this.open();
        }
      }
    });
    void window.loadFile(this.uiPath);
  }
  installTray() {
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVQ4T2NkYGD4z0ABYBw1YNSAUQMGAAAcEAERrxJuWQAAAABJRU5ErkJggg==",
    );
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("FlowGate");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 FlowGate", click: () => this.open() },
        { label: "断开代理", click: this.actions.disconnect },
        { type: "separator" },
        { label: "退出 FlowGate", click: this.actions.quit },
      ]),
    );
    this.tray.on("click", () => this.open());
  }
  recovery() {
    const window = this.window;
    this.window = undefined;
    window?.destroy();
    this.recovering = true;
    this.uiPath = join(this.bundle, "recovery.html");
    this.open();
  }
  async reload(path: string) {
    this.uiPath = path;
    this.recovering = false;
    const health = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = undefined;
        reject(new Error("新界面未通过就绪检查"));
      }, 10000);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    health.catch(() => {});
    if (!this.window || this.window.isDestroyed()) this.open();
    else await this.window.loadFile(path);
    await health;
  }
  publish(snapshot: unknown) {
    if (this.window && !this.window.isDestroyed() && !this.recovering)
      this.window.webContents.send("client:snapshot", snapshot);
  }
}
