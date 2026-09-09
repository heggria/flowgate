import catalog from "./builtin-catalog.json";
import type { CapabilityManifest, Lifecycle } from "./index";

export interface ExtensionDescriptor {
  id: string;
  name: string;
  description: string;
  version: string;
  required: boolean;
  defaultEnabled: boolean;
  dependencies: string[];
  capabilities: CapabilityManifest["capabilities"];
  permissions: string[];
  contributions: string[];
  methods: string[];
}
export interface ExtensionState extends ExtensionDescriptor {
  enabled: boolean;
  desiredEnabled: boolean;
  status: Lifecycle | "unavailable";
  instance?: string;
  error?: string;
  releaseSet: string;
}
export const builtinExtensions: readonly ExtensionDescriptor[] =
  catalog as ExtensionDescriptor[];
export function extensionPreferences(value: unknown): Record<string, boolean> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("扩展偏好无效");
  const preferences: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(value)) {
    const descriptor = builtinExtensions.find((entry) => entry.id === id);
    if (!descriptor || typeof enabled !== "boolean")
      throw new Error("未知扩展或无效启用状态");
    if (descriptor.required && !enabled) throw new Error("核心扩展不能停用");
    preferences[id] = enabled;
  }
  for (const descriptor of builtinExtensions) {
    if (!(preferences[descriptor.id] ?? descriptor.defaultEnabled)) continue;
    for (const dependency of descriptor.dependencies) {
      const target = builtinExtensions.find((entry) => entry.id === dependency);
      if (!target || !(preferences[dependency] ?? target.defaultEnabled))
        throw new Error("扩展依赖尚未启用");
    }
  }
  return preferences;
}
