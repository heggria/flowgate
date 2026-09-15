import test from "node:test";
import assert from "node:assert/strict";
import {
  adviseFailure,
  safeMessage,
  createProblemStore,
} from "../packages/client/src/problems";
test("actionable categories separate packaging, signature, approval and unknown outcome", () => {
  for (const [message, code, target] of [
    ["Codesigning failure -67028", "HELPER_BUNDLE", "settings"],
    ["HELPER_UNSIGNED 未签名", "HELPER_UNSIGNED", "settings"],
    ["HELPER_APPROVAL 等待系统批准", "HELPER_APPROVAL", "settings"],
    ["辅助服务会话失联，系统状态未知", "STATE_UNKNOWN", "network"],
    ["EADDRINUSE address already in use", "PORT_IN_USE", "settings"],
    ["订阅不存在", "RESOURCE", "nodes"],
    ["unexpected failure", "UNEXPECTED", "activity"],
  ]) {
    assert.equal(adviseFailure(message).code, code);
    assert.equal(adviseFailure(message).target, target);
  }
  assert.equal(adviseFailure("HELPER_UNSIGNED").approval, undefined);
  assert.equal(adviseFailure("HELPER_APPROVAL").approval, true);
});
test("visible/copyable errors strip transport wrappers and sensitive addresses", () => {
  const message = safeMessage(
    new Error(
      "Error invoking remote method 'shell:request': Error: failure https://user:pass@host/path?token=private password=secret Bearer abc.def",
    ),
  );
  for (const secret of [
    "user",
    "pass@",
    "private",
    "=secret",
    "abc.def",
    "invoking remote",
  ])
    assert.equal(message.includes(secret), false);
  assert.equal(safeMessage("x".repeat(3000)).length, 1600);
});
test("problems survive unrelated success, can be dismissed and remain reviewable", () => {
  const store = createProblemStore();
  let updates = 0;
  const stop = store.subscribe(() => updates++);
  store.report("proxy.connect", "EADDRINUSE");
  const id = store.snapshot()[0].id;
  store.resolve("network.refresh");
  assert.equal(store.snapshot()[0].resolved, false);
  store.dismiss(id);
  assert.equal(store.snapshot()[0].dismissed, true);
  store.report("proxy.connect", "EADDRINUSE");
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].count, 2);
  assert.equal(store.snapshot()[0].dismissed, false);
  store.resolve("proxy.connect");
  assert.equal(store.snapshot()[0].resolved, true);
  stop();
  assert.equal(updates, 4);
  for (let i = 0; i < 40; i++) store.report(String(i), "failure");
  assert.equal(store.snapshot().length, 30);
});

test("quoted credential fields stay private in visible and retained problems", () => {
  const credential = 'private phrase with "quotes" and spaces';
  const input = JSON.stringify({
    password: credential,
    access_token: "opaque-token",
    api_key: "provider-key",
    reason: "upstream rejected",
  });
  const message = safeMessage(input);
  for (const value of [
    "private phrase",
    "quotes",
    "opaque-token",
    "provider-key",
  ])
    assert.equal(message.includes(value), false);
  assert.match(message, /upstream rejected/);
  const store = createProblemStore();
  store.report("subscription.import", new Error(input));
  assert.equal(store.snapshot()[0].message, message);
  assert.equal(
    safeMessage("secret='a long private phrase'").includes("private phrase"),
    false,
  );
});

import { createSnapshotProblemObserver } from "../packages/client/src/problems";
test("persisted background failures remain visible even with a stopped kernel; polling is deduplicated", () => {
  const store = createProblemStore(),
    observe = createSnapshotProblemObserver(store);
  const snapshot = {
    kernel: { status: "stopped" as const, systemControl: false },
    operations: [
      {
        id: "auto",
        traceId: "auto",
        kind: "proxy.connect",
        state: "failed" as const,
        revision: 1,
        startedAt: "2026-01-01T00:00:00Z",
        message: "后台自动连接失败",
      },
    ],
  };
  observe(snapshot);
  observe(snapshot);
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].resolved, false);
  assert.equal(store.snapshot()[0].count, 1);
  observe({
    ...snapshot,
    operations: [
      {
        ...snapshot.operations[0],
        id: "new",
        state: "succeeded",
        completedAt: "2999-01-01T00:00:00Z",
      },
      ...snapshot.operations,
    ],
  });
  assert.equal(store.snapshot()[0].resolved, true);
});
test("request failure and snapshot failure do not create duplicate notifications", () => {
  const store = createProblemStore(),
    observe = createSnapshotProblemObserver(store);
  store.report("proxy.connect", "端口被占用");
  observe({
    kernel: { status: "stopped", systemControl: false },
    operations: [
      {
        id: "one",
        traceId: "one",
        kind: "proxy.connect",
        state: "failed",
        revision: 1,
        startedAt: "2026-01-01",
        message: "端口被占用",
      },
    ],
  });
  assert.equal(store.snapshot()[0].count, 1);
});
