import { setTimeout as delay } from "node:timers/promises";

export function isContextReplacementError(error) {
  return (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context with specified id/.test(
      error.message,
    )
  );
}

// Evaluate asynchronous browser predicates in Node so false results are retried.
export async function waitForAsyncPredicate(
  read,
  { timeout = 30000, polling = 100, retryOnError } = {},
) {
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new RangeError("timeout must be positive and finite");
  if (!Number.isFinite(polling) || polling <= 0)
    throw new RangeError("polling must be positive and finite");
  const deadline = performance.now() + timeout;
  let lastError;
  const timedOut = () => {
    const error = new Error(
      `Async predicate did not become true within ${timeout}ms`,
      lastError ? { cause: lastError } : undefined,
    );
    error.name = "TimeoutError";
    return error;
  };
  while (performance.now() < deadline) {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(timedOut()),
            deadline - performance.now(),
          );
        }),
      ]);
      if (performance.now() >= deadline) throw timedOut();
      if (value === true) return;
    } catch (error) {
      if (performance.now() >= deadline || !retryOnError?.(error)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await delay(Math.min(polling, Math.max(0, deadline - performance.now())));
  }
  throw timedOut();
}
