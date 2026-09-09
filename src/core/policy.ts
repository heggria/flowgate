import { isIP } from 'node:net';
import type { Decision, PreviewInput } from './types';
function domain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.length > 253 || !normalized.split('.').every(p => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))) throw new Error('请输入有效域名或 IP，不要包含 URL 路径');
  return normalized;
}
export function preview(input: PreviewInput): Decision {
  if (!input || typeof input.target !== 'string' || typeof input.corporateSuffix !== 'string') throw new Error('预览参数无效');
  const raw = input.target.trim();
  if (!raw || raw.length > 253) throw new Error('请输入目标域名或 IP');
  const ip = isIP(raw);
  const target = ip ? raw.toLowerCase() : domain(raw);
  const suffix = input.corporateSuffix.trim() ? domain(input.corporateSuffix) : '';
  const result = (category: string, context: string, reason: string, dns: string, fallback: string): Decision => ({ category, context, reason, dns, fallback, applied: false });
  if (!ip && suffix && (target === suffix || target.endsWith(`.${suffix}`))) return result('内部域名（用户指定）', '公司网络（待绑定）', `目标匹配域名边界 .${suffix}；不自动把 Tailscale 当作公司 VPN`, '公司解析器（待配置）', '出口不可用时停止，不转公共代理');
  if (ip === 4) {
    const [a,b] = target.split('.').map(Number);
    if (a === 127) return result('本机回环', '本机', '匹配 IPv4 回环地址', '无需 DNS', '无备用出口');
    if ((a === 10) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return result('私有地址（归属未知）', '需要确认网络归属', '公司和家庭网段可能重叠，不能自动选择直连', '无需 DNS', '未确认前不生成可执行策略');
    if (a === 100 && b >= 64 && b <= 127) return result('共享地址空间', '需要确认网络归属', '100.64.0.0/10 也用于运营商网络，不能仅凭地址判为 Tailscale', '无需 DNS', '未确认前不生成可执行策略');
  }
  if (ip === 6) return result('IPv6 地址', '需要确认网络归属', '首版不对 IPv6 生成出口假设', '无需 DNS', '未确认前不生成可执行策略');
  return result('其他流量', '默认策略（待配置）', '没有命中内部域名或已识别地址分类', ip ? '无需 DNS' : '默认解析器（待配置）', '由用户明确选择；本次仅预览');
}
