import { setAppearance, syncAppearanceMenu } from "./appearance";
import { app, Menu, shell } from "electron";
import { join } from "node:path";

export function installApplicationMenu(
  bundle: string,
  navigate: (route: string) => void,
) {
  app.setAboutPanelOptions({
    applicationName: "FlowGate",
    applicationVersion: app.getVersion(),
    copyright: "FlowGate · GPL-3.0-or-later",
    iconPath: join(bundle, "assets/app-icon.png"),
  });
  const menu = Menu.buildFromTemplate([
    {
      label: "FlowGate",
      submenu: [
        { role: "about", label: "关于 FlowGate" },
        { type: "separator" },
        {
          label: "设置…",
          accelerator: "Command+,",
          click: () => navigate("settings"),
        },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 FlowGate" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出 FlowGate" },
      ],
    },
    { label: "文件", submenu: [{ role: "close", label: "关闭窗口" }] },
    { role: "editMenu", label: "编辑" },
    {
      label: "显示",
      submenu: [
        {
          label: "查找功能…",
          accelerator: "Command+K",
          click: () => navigate("__search"),
        },
        { type: "separator" },
        {
          label: "外观",
          submenu: [
            {
              id: "appearance-system",
              type: "radio",
              label: "跟随系统",
              click: () => setAppearance("system"),
            },
            {
              id: "appearance-light",
              type: "radio",
              label: "浅色",
              click: () => setAppearance("light"),
            },
            {
              id: "appearance-dark",
              type: "radio",
              label: "深色",
              click: () => setAppearance("dark"),
            },
          ],
        },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "进入全屏幕" },
      ],
    },
    { role: "windowMenu", label: "窗口" },
    {
      role: "help",
      label: "帮助",
      submenu: [
        {
          label: "FlowGate 使用指南",
          click: () => {
            void shell.openExternal(
              "https://github.com/heggria/flowgate#readme",
            );
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
  syncAppearanceMenu();
  return menu;
}
