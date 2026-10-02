import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  isContextReplacementError,
  waitForAsyncPredicate,
} from "./async-poll.mjs";

test("async polling retries a resolved false and waits for the next true", async () => {
  let calls = 0;
  let completed = 0;
  await waitForAsyncPredicate(
    async () => {
      calls++;
      await delay(5);
      completed++;
      return completed === 2;
    },
    { timeout: 1000, polling: 1 },
  );
  assert.equal(calls, 2);
  assert.equal(completed, 2);
});

test("async polling times out when every awaited result is false", async () => {
  let calls = 0;
  await assert.rejects(
    waitForAsyncPredicate(
      async () => {
        calls++;
        await delay(1);
        return false;
      },
      { timeout: 40, polling: 1 },
    ),
    { name: "TimeoutError", message: /did not become true within 40ms/ },
  );
  assert.ok(calls >= 1);
});

test("async polling bounds a stalled browser request by the same deadline", async () => {
  await assert.rejects(
    waitForAsyncPredicate(() => new Promise<boolean>(() => {}), {
      timeout: 20,
    }),
    { name: "TimeoutError" },
  );
});

test("only explicitly allowed context replacement errors are retried", async () => {
  const contextError = new Error(
    "Execution context was destroyed, most likely because of a navigation",
  );
  let calls = 0;
  await waitForAsyncPredicate(
    async () => {
      if (++calls === 1) throw contextError;
      return true;
    },
    { timeout: 1000, polling: 1, retryOnError: isContextReplacementError },
  );
  assert.equal(calls, 2);
  const closed = new Error("Target page, context or browser has been closed");
  await assert.rejects(
    waitForAsyncPredicate(
      async () => {
        throw closed;
      },
      {
        retryOnError: isContextReplacementError,
      },
    ),
    (error) => error === closed,
  );
});
