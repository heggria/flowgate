import assert from "node:assert/strict";
import { once } from "node:events";
import { within } from "./soak-cleanup.mjs";

// Only the original ChildProcess handle is accepted; never kill a recovered PID.
export async function stopOwnedChild(
  child,
  { timeout = 5000, killTimeout = 5000 } = {},
) {
  assert.ok(
    child?.pid && typeof child.kill === "function",
    "Cleanup requires an owned child handle",
  );
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited())
    return {
      forced: false,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  let forced = false;
  try {
    await within(exit, timeout, "Owned child SIGTERM deadline exceeded");
  } catch (error) {
    if (!exited()) {
      forced = true;
      child.kill("SIGKILL");
      await within(exit, killTimeout, "Owned child SIGKILL deadline exceeded");
    }
  }
  assert.ok(exited(), "Owned child did not actually exit");
  return { forced, exitCode: child.exitCode, signalCode: child.signalCode };
}

export async function cleanupStages(stages) {
  const failures = [];
  for (const stage of stages) {
    try {
      await stage();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Cleanup stages failed");
}
