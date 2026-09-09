import test from "node:test";
import assert from "node:assert/strict";
import { PausableTimers } from "../packages/shell/src/pausable-timers";
import { NetworkObserver } from "../packages/service/src/network-observer";
import type { NetworkState } from "../packages/contracts/src/index";

test("sleep duration does not consume pending request deadline", () => {
  let now = 0,
    next = 0,
    fired = 0;
  const callbacks = new Map<number, { at: number; callback: () => void }>();
  const timers = new PausableTimers(
    () => now,
    ((callback: () => void, delay: number) => {
      const id = ++next;
      callbacks.set(id, { at: now + delay, callback });
      return id;
    }) as any,
    ((id: number) => {
      callbacks.delete(id);
    }) as any,
  );
  timers.timeout(() => fired++, 100);
  now = 30;
  timers.pause();
  now = 3600030;
  assert.equal(callbacks.size, 0);
  timers.resume();
  assert.equal([...callbacks.values()][0].at, now + 70);
  assert.equal(fired, 0);
  [...callbacks.values()][0].callback();
  assert.equal(fired, 1);
});

test("resume rejects late pre-sleep network observations and performs a fresh read", async () => {
  const resolvers: ((state: NetworkState) => void)[] = [],
    published: NetworkState[] = [];
  const observer = new NetworkObserver(
    () => new Promise((resolve) => resolvers.push(resolve)),
    (state) => published.push(state),
    () => {},
  );
  const before = observer.refresh();
  await Promise.resolve();
  observer.stop();
  observer.resume();
  await Promise.resolve();
  const stale = { warnings: ["stale"] } as NetworkState;
  const fresh = { warnings: ["fresh"] } as NetworkState;
  resolvers[0](stale);
  await before;
  assert.deepEqual(published, []);
  resolvers[1](fresh);
  await observer.refresh();
  assert.deepEqual(published, [fresh]);
  observer.stop();
});
