import type { NodeConfig } from "../../contracts/src/index";
import { parseSubscriptionDocument } from "./subscriptions/index";
export { parseSubscriptionDocument } from "./subscriptions/index";
/** Compatibility API: callers without a preview must accept all nodes or keep the last good configuration. */
export function parseSubscription(
  text: string,
  sourceId?: string,
): NodeConfig[] {
  const result = parseSubscriptionDocument(text);
  if (result.rejected)
    throw new Error("部分节点不能无损转换，请使用订阅预览检查");
  return result.nodes.map((node) => ({ ...node, sourceId }));
}
