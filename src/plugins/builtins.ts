import { access } from 'node:fs/promises';
import { run } from '../platform/macos';
import { PluginRegistry } from '../core/registry';
async function installed(path: string) { try { await access(path); return true; } catch { return false; } }
async function running(name: string): Promise<boolean | null> {
  try { await run('/usr/bin/pgrep', ['-x', name]); return true; }
  catch (error) { return (error as {code?: number}).code === 1 ? false : null; }
}
export function createRegistry() {
  const registry = new PluginRegistry();
  registry.register({ id: 'builtin.tailscale', apiVersion: 1, name: 'Tailscale', async inspect() {
    const path = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    if (!await installed(path)) return { id: 'builtin.tailscale', name: 'Tailscale', installed: false, running: false, detail: '标准安装目录未发现应用' };
    try {
      const state = JSON.parse(await run(path, ['status', '--json', '--peers=false']));
      return { id: 'builtin.tailscale', name: 'Tailscale', installed: true, running: state.BackendState === 'Running', detail: `后端状态：${String(state.BackendState ?? '未知')}。未读取 Peer 清单；不推断公司网段或出口节点。` };
    } catch { return { id: 'builtin.tailscale', name: 'Tailscale', installed: true, running: null, detail: '已安装，CLI 状态不可用', error: '读取失败或超时' }; }
  }});
  registry.register({ id: 'builtin.singbox', apiVersion: 1, name: 'GUI.for.SingBox', async inspect() {
    const [found, gui, kernel] = await Promise.all([installed('/Applications/GUI.for.SingBox.app'), running('GUI.for.SingBox'), running('sing-box')]);
    return { id: 'builtin.singbox', name: 'GUI.for.SingBox', installed: found, running: kernel, detail: `界面进程：${gui === null ? '未知' : gui ? '运行中' : '未发现'}；名为 sing-box 的内核进程：${kernel === null ? '未知' : kernel ? '运行中' : '未发现'}。不读取订阅或控制令牌。` };
  }});
  return registry;
}
