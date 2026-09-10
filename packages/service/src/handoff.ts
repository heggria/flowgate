import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./store";
export interface Handoff {
  version: 1;
  protocol: 1;
  schema: 1 | 2;
  releaseSet: string;
  epoch: number;
  revision: number;
  pendingOperationIds: string[];
  at: string;
}
export async function readHandoff(
  directory: string,
  revision: number,
): Promise<Handoff | null> {
  try {
    const handoff = JSON.parse(
      await readFile(join(directory, "handoff.json"), "utf8"),
    ) as Handoff;
    if (
      handoff.version !== 1 ||
      handoff.protocol !== 1 ||
      ![1, 2].includes(handoff.schema) ||
      !Number.isSafeInteger(handoff.revision) ||
      handoff.revision > revision ||
      !Array.isArray(handoff.pendingOperationIds)
    )
      throw new Error("服务交接记录不兼容或数据修订丢失");
    return handoff;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function writeHandoff(directory: string, value: Handoff) {
  await atomicWrite(join(directory, "handoff.json"), value);
}
