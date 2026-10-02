import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AppSnapshot } from "../../packages/contracts/src/index";

export async function readSoakStopRequest(path: string, runId: string) {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const request = JSON.parse(content);
  if (request?.runId !== runId) return undefined;
  return typeof request.reason === "string"
    ? request.reason.slice(0, 300)
    : "Requested stop";
}

/** A PID change is admissible only when a new, completed Service operation explains it. */
export function explainCoordinatedRestart(
  previous: AppSnapshot,
  current: AppSnapshot,
  oldProcessAlive: boolean,
) {
  assert.equal(current.epoch, previous.epoch, "Service restarted unexpectedly");
  assert.ok(previous.kernel.pid && current.kernel.pid);
  assert.notEqual(current.kernel.pid, previous.kernel.pid);
  assert.equal(oldProcessAlive, false, "Replaced kernel must not survive");
  assert.equal(current.kernel.status, "running");
  assert.equal(current.configuration.revision, previous.configuration.revision);
  assert.equal(current.kernel.appliedRevision, current.configuration.revision);
  const operation = current.operations.find(
    (entry) => entry.id === current.kernel.operationId,
  );
  assert.ok(
    operation,
    "Kernel replacement has no matching persisted operation",
  );
  assert.ok(
    operation.id.startsWith("network-"),
    "Unexpected kernel replacement",
  );
  assert.equal(operation.kind, "proxy.connect");
  assert.equal(operation.state, "succeeded");
  assert.equal(operation.revision, current.configuration.revision);
  assert.equal(
    previous.operations.some((entry) => entry.id === operation.id),
    false,
    "An old operation cannot explain a new kernel replacement",
  );
  return {
    previousPID: previous.kernel.pid,
    currentPID: current.kernel.pid,
    operationId: operation.id,
    revision: operation.revision,
    startedAt: operation.startedAt,
    completedAt: operation.completedAt,
    // Field names aid diagnosis without putting network addresses into the report.
    observedFieldsChanged: Object.keys(current.network ?? {}).filter(
      (key) =>
        !["capturedAt", "warnings", "plugins"].includes(key) &&
        JSON.stringify((previous.network as any)?.[key]) !==
          JSON.stringify((current.network as any)?.[key]),
    ),
  };
}
