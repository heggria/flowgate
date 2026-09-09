import { test } from "node:test";
import assert from "node:assert/strict";
import { TrafficHistory } from "../packages/service/src/kernel/traffic-history";
test("traffic rate uses counter delta and real elapsed time; resets/gaps remain unknown", () => {
  const h = new TrafficHistory();
  assert.equal(h.sample(1000, 100, 200).uploadRate, null);
  assert.deepEqual(h.sample(3000, 300, 800), {
    at: 3000,
    uploadRate: 100,
    downloadRate: 300,
  });
  assert.equal(h.sample(4000, 300, 800).uploadRate, 0);
  assert.equal(h.sample(10000, 900, 900).uploadRate, null);
  assert.equal(h.sample(11000, 0, 0).uploadRate, null);
  h.reset();
  assert.equal(h.points.length, 0);
  assert.equal(h.sample(12000, 900, 900).downloadRate, null);
});
test("telemetry retains at most ten minutes of samples", () => {
  const h = new TrafficHistory();
  for (let i = 0; i < 1000; i++) h.sample(i * 1000, i, i);
  assert.equal(h.points.length, 600);
  assert.equal(h.points[0].at, 400000);
});
