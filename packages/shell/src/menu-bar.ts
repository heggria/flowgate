import { Menu, Tray, type NativeImage } from "electron";
import type { AppSnapshot } from "../../contracts/src/index";

export const MENU_BAR_ID = "e6de804e-41d4-4f24-8817-e19181f794e1";

export interface MenuBarActions {
  open(): void;
  settings(): void;
  connect(): void;
  disconnect(): void;
  quit(): void;
}
export function menuBarPresentation(input?: unknown) {
  const snapshot =
    input && typeof input === "object"
      ? (input as Partial<AppSnapshot>)
      : undefined;
  const status = snapshot?.kernel?.status;
  const labels: Record<string, string> = {
    running: "代理运行中",
    stopped: "代理已停止",
    starting: "正在启动代理…",
    stopping: "正在停止代理…",
    failed: "代理需要处理",
  };
  const pending =
    status === "running" &&
    snapshot?.kernel?.appliedRevision !== snapshot?.configuration?.revision;
  return {
    label:
      (status ? (labels[status] ?? "代理状态未知") : "正在连接服务…") +
      (pending ? " · 有配置待应用" : ""),
    control: status === "stopped" ? "connect" : "disconnect",
    canControl: ["stopped", "running", "failed", "unknown"].includes(
      status ?? "",
    ),
  };
}
/** The menu bar belongs to the fixed shell and survives renderer replacement. */
export class MenuBarController {
  private tray?: Tray;
  private signature = "";
  constructor(
    private readonly icon: NativeImage,
    private readonly actions: MenuBarActions,
    private readonly createTray: (image: NativeImage, guid: string) => Tray = (
      image,
      guid,
    ) => new Tray(image, guid),
  ) {}
  install() {
    if (this.tray && !this.tray.isDestroyed()) return;
    this.signature = "";
    this.icon.setTemplateImage(true);
    this.tray = this.createTray(this.icon, MENU_BAR_ID);
    // A missing image must not leave an invisible menu-bar target.
    if (this.icon.isEmpty()) this.tray.setTitle("FG");
    this.tray.setIgnoreDoubleClickEvents(true);
    this.update();
  }
  update(snapshot?: unknown) {
    if (!this.tray || this.tray.isDestroyed()) return;
    const state = menuBarPresentation(snapshot);
    const signature = JSON.stringify(state);
    if (signature === this.signature) return;
    this.signature = signature;
    this.tray.setToolTip("FlowGate — " + state.label);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: state.label, enabled: false },
        { type: "separator" },
        { label: "打开 FlowGate", click: this.actions.open },
        { label: "设置…", click: this.actions.settings },
        { type: "separator" },
        {
          label: state.control === "connect" ? "启动代理" : "停止代理",
          enabled: state.canControl,
          click:
            state.control === "connect"
              ? this.actions.connect
              : this.actions.disconnect,
        },
        { type: "separator" },
        { label: "退出 FlowGate", click: this.actions.quit },
      ]),
    );
  }
  dispose() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = undefined;
    this.signature = "";
  }
}
