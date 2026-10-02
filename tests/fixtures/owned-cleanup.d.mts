import type { ChildProcess } from "node:child_process";
export function stopOwnedChild(
  child: ChildProcess,
  options?: { timeout?: number; killTimeout?: number },
): Promise<{
  forced: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}>;
export function cleanupStages(
  stages: Array<() => Promise<unknown> | unknown>,
): Promise<void>;
