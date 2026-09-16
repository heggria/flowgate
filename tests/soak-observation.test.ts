import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppSnapshot } from "../packages/contracts/src/index";
import {
  explainCoordinatedRestart,
  readSoakStopRequest,
} from "./fixtures/soak-observation";

test("cooperative stop requests belong to one run and stale requests are ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-soak-stop-"));
  const path = join(directory, "stop.json");
  try {
    assert.equal(await readSoakStopRequest(path, "current"), undefined);
    await writeFile(path, JSON.stringify({ runId: "old", reason: "stale" }));
    assert.equal(await readSoakStopRequest(path, "current"), undefined);
    await writeFile(
      path,
      JSON.stringify({ runId: "current", reason: "candidate superseded" }),
    );
    assert.equal(
      await readSoakStopRequest(path, "current"),
      "candidate superseded",
    );
    await writeFile(path, "{");
    await assert.rejects(readSoakStopRequest(path, "current"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function observations() {
  const previous = {
    epoch: 1,
    configuration: { revision: 3 },
    kernel: {
      pid: 100,
      status: "running",
      appliedRevision: 3,
      operationId: "user-connect",
    },
    operations: [],
    network: { defaultInterface: "en0" },
  } as unknown as AppSnapshot;
  const current = structuredClone(previous);
  current.kernel = { ...current.kernel, pid: 101, operationId: "network-new" };
  current.operations = [
    {
      id: "network-new",
      traceId: "trace",
      kind: "proxy.connect",
      state: "succeeded",
      revision: 3,
      startedAt: "2026-09-15T10:00:00Z",
      completedAt: "2026-09-15T10:00:01Z",
    },
  ];
  current.network!.defaultInterface = "en1";
  return { previous, current };
}

test("soak records a new completed network reconnect with an exited predecessor", () => {
  const { previous, current } = observations();
  const result = explainCoordinatedRestart(previous, current, false);
  assert.equal(result.operationId, "network-new");
  assert.deepEqual(result.observedFieldsChanged, ["defaultInterface"]);
});

test("soak rejects unexplained, failed, stale, mismatched and leaking replacements", () => {
  const invalid: ((pair: ReturnType<typeof observations>) => void)[] = [
    ({ current }) => {
      current.operations = [];
    },
    ({ current }) => {
      current.operations[0].state = "failed";
    },
    ({ current }) => {
      current.operations[0].state = "pending";
    },
    ({ current }) => {
      current.operations[0].revision = 2;
    },
    ({ current }) => {
      current.kernel.appliedRevision = 2;
    },
    ({ current }) => {
      current.epoch = 2;
    },
    ({ current }) => {
      current.configuration.revision = 4;
    },
    ({ current }) => {
      current.operations[0].kind = "proxy.disconnect";
    },
    ({ previous, current }) => {
      previous.operations = structuredClone(current.operations);
    },
    ({ current }) => {
      current.operations[0].id = current.kernel.operationId = "user-other";
    },
  ];
  for (const mutate of invalid) {
    const pair = observations();
    mutate(pair);
    assert.throws(() =>
      explainCoordinatedRestart(pair.previous, pair.current, false),
    );
  }
  const { previous, current } = observations();
  assert.throws(() => explainCoordinatedRestart(previous, current, true));
});
