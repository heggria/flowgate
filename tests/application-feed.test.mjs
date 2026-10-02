import test from "node:test";
import assert from "node:assert/strict";
import {
  compareApplicationVersions,
  createApplicationFeed,
} from "../scripts/application-feed.mjs";
const input = {
  version: "0.3.3",
  url: "https://updates.example/FlowGate.zip",
  notes: "Test release",
  publishedAt: "2026-09-15T00:00:00.000Z",
  sha256: "a".repeat(64),
  size: 1234,
};
test("application version ordering uses numeric components and rejects ambiguous prerelease values", () => {
  assert.equal(compareApplicationVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareApplicationVersions("0.3.3", "0.3.3"), 0);
  assert.equal(compareApplicationVersions("0.3.2", "0.3.3"), -1);
  for (const version of ["0.3.3-rc.1", "03.3.3", "3", "1.2.3.4", undefined])
    assert.throws(() => compareApplicationVersions(version, "0.3.3"));
});
test("application metadata rejects unsafe URLs and missing archive integrity information", () => {
  for (const url of [
    "http://updates.example/app.zip",
    "https://user:secret@updates.example/app.zip",
    "file:///app.zip",
    "https://updates.example/app.zip#fragment",
    "invalid",
  ])
    assert.throws(() => createApplicationFeed({ ...input, url }));
  for (const fields of [
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { sha256: "" },
    { notes: "" },
    { publishedAt: "invalid" },
  ])
    assert.throws(() => createApplicationFeed({ ...input, ...fields }));
  const feed = createApplicationFeed(input);
  assert.equal(feed.currentRelease, input.version);
  assert.equal(feed.releases[0].updateTo.sha256, input.sha256);
  assert.equal(feed.releases[0].updateTo.size, input.size);
});
