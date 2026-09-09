import type { PluginReport } from './types';
export interface DiagnosticPlugin { id: string; apiVersion: 1; name: string; inspect(): Promise<PluginReport> }
// Trusted built-ins only. The host provides process isolation, not a code sandbox.
export class PluginRegistry {
  private entries = new Map<string, DiagnosticPlugin>();
  register(plugin: DiagnosticPlugin): () => void {
    if (plugin.apiVersion !== 1) throw new Error('不支持的插件 API 版本');
    if (this.entries.has(plugin.id)) throw new Error(`插件 ID 重复: ${plugin.id}`);
    this.entries.set(plugin.id, plugin);
    return () => { if (this.entries.get(plugin.id) === plugin) this.entries.delete(plugin.id); };
  }
  async inspect(): Promise<PluginReport[]> {
    return Promise.all([...this.entries.values()].map(async plugin => {
      try { return await plugin.inspect(); }
      catch { return { id: plugin.id, name: plugin.name, installed: false, running: null, detail: '无法获取状态', error: '诊断失败；请刷新重试' }; }
    }));
  }
}
