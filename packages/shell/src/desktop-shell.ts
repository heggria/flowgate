import { beforeDeadline } from "../../runtime/src/deadline";
import { BUILD_VERSION } from "../../contracts/src/version";
import { BrowserWindow, nativeImage } from "electron";
import { readAppearance, subscribeAppearance } from "./appearance";
import { MenuBarController } from "./menu-bar";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { backgroundTest } from "./test-mode";
let nextRendererEpoch = Date.now();
export class DesktopShell {
  uiIdentity = { releaseSet: "bundled", hostVersion: BUILD_VERSION };
  uiEpoch = ++nextRendererEpoch;
  private readyResolve?: () => void;
  ready = false;
  markReady() {
    this.ready = true;
    this.readyResolve?.();
    this.readyResolve = undefined;
  }
  window?: BrowserWindow;
  private tray?: MenuBarController;
  private rendererFailures = 0;
  private removeAppearanceListener: () => void;
  private appearanceChanged = () => {
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send("shell:appearance", readAppearance());
  };
  quitting = false;
  recovering = false;
  constructor(
    readonly bundle: string,
    public uiPath: string,
    readonly actions: {
      quit: () => void;
      connect: () => void;
      disconnect: () => void;
      navigate: (route: string) => void;
      rendererFault?: () => Promise<boolean>;
    },
  ) {
    this.removeAppearanceListener = subscribeAppearance(this.appearanceChanged);
  }
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
      if (!backgroundTest) {
        this.window.show();
        this.window.focus();
      }
      return;
    }
    const window = new BrowserWindow({
      show: false,
      focusable: !backgroundTest,
      skipTaskbar: backgroundTest,
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
        backgroundThrottling: !backgroundTest,
        focusOnNavigation: !backgroundTest,
      },
    });
    this.window = window;
    this.ready = false;
    window.once("ready-to-show", () => {
      if (!backgroundTest && !this.quitting && this.window === window)
        window.show();
    });
    this.uiEpoch = ++nextRendererEpoch;
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
    window.webContents.on("render-process-gone", async (_event, details) => {
      if (
        !this.quitting &&
        this.window === window &&
        details.reason !== "clean-exit"
      ) {
        if (await this.actions.rendererFault?.()) return;
        if (this.quitting || this.window !== window) return;
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
    if (backgroundTest) return;
    const icon = nativeImage.createFromPath(
      join(this.bundle, "assets/menuBarTemplate.png"),
    );
    this.tray = new MenuBarController(icon, {
      open: () => this.open(),
      settings: () => this.actions.navigate("settings"),
      connect: this.actions.connect,
      disconnect: this.actions.disconnect,
      quit: this.actions.quit,
    });
    this.tray.install();
  }
  dispose() {
    this.removeAppearanceListener();
    this.tray?.dispose();
  }

  recovery() {
    this.tray?.update({ kernel: { status: "unknown" } });
    const window = this.window;
    this.window = undefined;
    window?.destroy();
    this.recovering = true;
    this.uiPath = join(this.bundle, "recovery.html");
    this.open();
  }
  async prepareRelease() {
    if (
      this.window &&
      !this.window.isDestroyed() &&
      !this.window.webContents.isCrashed() &&
      !this.recovering
    )
      await beforeDeadline(
        this.window.webContents.executeJavaScript(
          "window.shell?.prepareRelease?.()",
        ),
        Date.now() + 5000,
        "界面模块",
      );
  }
  async reload(path: string, identity = this.uiIdentity) {
    await this.prepareRelease();
    this.uiIdentity = identity;
    this.uiEpoch = ++nextRendererEpoch;
    if (path !== this.uiPath) this.rendererFailures = 0;
    this.uiPath = path;
    this.ready = false;
    this.recovering = false;
    if (this.window?.webContents.isCrashed()) {
      const crashed = this.window;
      this.window = undefined;
      crashed.destroy();
    }
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
    this.tray?.update(snapshot);
    if (this.window && !this.window.isDestroyed() && !this.recovering)
      this.window.webContents.send("client:snapshot", snapshot);
  }
}
