import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AutoUpdater } from "electron";
import { ApplicationUpdate } from "../packages/shell/src/application-update";
import type { ApplicationUpdateState } from "../packages/contracts/src/index";
function fixture(feed = "https://updates.example/app", packaged = true) {
  const events = new EventEmitter();
  let checks = 0;
  let fail = false;
  const changes: ApplicationUpdateState[] = [];
  const updater = Object.assign(events, {
    setFeedURL() {
      if (fail) throw Error("secret credential from transport");
    },
    checkForUpdates() {
      checks++;
    },
  }) as unknown as AutoUpdater;
  const app = new ApplicationUpdate(feed, {
    updater,
    isPackaged: () => packaged,
    onChange: (s) => changes.push(s),
  });
  return {
    app,
    events,
    changes,
    get checks() {
      return checks;
    },
    fail() {
      fail = true;
    },
  };
}
test("application updater reports async progress, deduplicates checks and preserves downloaded update", () => {
  const f = fixture();
  f.app.check();
  f.app.check();
  assert.equal(f.checks, 1);
  f.events.emit("update-available");
  assert.equal(f.app.state.phase, "downloading");
  f.app.check();
  assert.equal(f.checks, 1);
  f.events.emit("update-downloaded");
  f.app.check();
  f.events.emit("update-not-available");
  f.events.emit("error", Error("late error"));
  assert.equal(f.app.state.phase, "ready");
  assert.equal(f.checks, 1);
  assert.deepEqual(
    f.changes.map((s) => s.phase),
    ["checking", "downloading", "ready"],
  );
  assert.deepEqual(
    f.changes.map((s) => s.revision),
    [1, 2, 3],
  );
  f.app.state.message = "mutated reader copy";
  assert.match(f.app.state.message, /下次启动/);
});
test("async failure is visible, redacted and retryable; current version is terminal", () => {
  const f = fixture();
  f.app.check();
  f.events.emit("error", Error("credential"));
  assert.equal(f.app.state.phase, "failed");
  assert.doesNotMatch(f.app.state.message, /credential/);
  f.app.check();
  assert.equal(f.checks, 2);
  f.events.emit("update-not-available");
  assert.equal(f.app.state.phase, "current");
  f.events.emit("update-available");
  assert.equal(f.app.state.phase, "current");
});
test("invalid feed, unpackaged app and synchronous updater failures remain visible", () => {
  for (const f of [
    fixture("https://"),
    fixture("http://updates.example"),
    fixture("", true),
    fixture(undefined, false),
  ]) {
    assert.throws(() => f.app.check());
    assert.equal(f.app.state.phase, "failed");
    assert.equal(f.checks, 0);
  }
  const f = fixture();
  f.fail();
  assert.throws(() => f.app.check(), /应用更新失败/);
  assert.equal(f.app.state.phase, "failed");
  assert.doesNotMatch(JSON.stringify(f.changes), /credential/);
});
