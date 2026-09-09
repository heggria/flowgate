import { BUILD_VERSION } from "../../packages/contracts/src/version";
import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("flowgate", {
  cancel: (operationId: string) =>
    ipcRenderer.invoke("client:cancel", operationId),
  request: (method: string, payload?: unknown, operationId?: string) =>
    ipcRenderer.invoke("client:request", { method, payload, operationId }),
  subscribe: (listener: (value: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("client:snapshot", handler);
    return () => ipcRenderer.removeListener("client:snapshot", handler);
  },
});
contextBridge.exposeInMainWorld("shell", {
  onNavigate: (listener: (route: string) => void) => {
    const handler = (_event: unknown, route: string) => listener(route);
    ipcRenderer.on("shell:navigate", handler);
    return () => ipcRenderer.removeListener("shell:navigate", handler);
  },
  version: BUILD_VERSION,
  platform: process.platform,
  request: (method: string, payload?: unknown) =>
    ipcRenderer.invoke("shell:request", { method, payload }),
});
