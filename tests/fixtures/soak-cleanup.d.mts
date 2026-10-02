import type { ChildProcess } from "node:child_process";
export function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  message?: string,
): Promise<T>;
export function captureSoakChild(app: { process(): ChildProcess }): unknown;
export function captureSoakProcess(
  app: unknown,
  data: string,
  executablePath: string,
  options?: unknown,
): Promise<unknown>;
export function closeSoakApp(app: unknown, owned?: unknown): Promise<unknown>;
