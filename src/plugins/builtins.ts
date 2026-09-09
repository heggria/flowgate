import { access } from "node:fs/promises";
import { run } from "../platform/macos";
import type { PluginReport } from "../core/types";
async function installed(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function running(
  name: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  try {
    await run("/usr/bin/pgrep", ["-x", name], signal);
    return true;
  } catch (error) {
    return (error as { code?: number }).code === 1 ? false : null;
  }
}
export function diagnosticPlugins(): {
  id: string;
  apiVersion: 1;
  name: string;
  inspect(signal?: AbortSignal): Promise<PluginReport>;
}[] {
  return [
    {
      id: "builtin.tailscale",
      apiVersion: 1,
      name: "Tailscale",
      async inspect(signal?: AbortSignal) {
        signal?.throwIfAborted();
        const path = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
        if (!(await installed(path)))
          return {
            id: "builtin.tailscale",
            name: "Tailscale",
            installed: false,
            running: false,
            detail: "标准安装目录未发现应用",
          };
        try {
          const state = JSON.parse(
            await run(path, ["status", "--json", "--peers=false"], signal),
          );
          return {
            id: "builtin.tailscale",
            name: "Tailscale",
            installed: true,
            running: state.BackendState === "Running",
            detail: `后端状态：${String(state.BackendState ?? "未知")}。未读取 Peer 清单；不推断公司网段或出口节点。`,
          };
        } catch {
          return {
            id: "builtin.tailscale",
            name: "Tailscale",
            installed: true,
            running: null,
            detail: "已安装，CLI 状态不可用",
            error: "读取失败或超时",
          };
        }
      },
    },
    {
      id: "builtin.singbox",
      apiVersion: 1,
      name: "GUI.for.SingBox",
      async inspect(signal?: AbortSignal) {
        signal?.throwIfAborted();
        const [found, gui, kernel] = await Promise.all([
          installed("/Applications/GUI.for.SingBox.app"),
          running("GUI.for.SingBox", signal),
          running("sing-box", signal),
        ]);
        return {
          id: "builtin.singbox",
          name: "GUI.for.SingBox",
          installed: found,
          running: kernel,
          detail: `界面进程：${gui === null ? "未知" : gui ? "运行中" : "未发现"}；名为 sing-box 的内核进程：${kernel === null ? "未知" : kernel ? "运行中" : "未发现"}。不读取订阅或控制令牌。`,
        };
      },
    },
  ];
}
