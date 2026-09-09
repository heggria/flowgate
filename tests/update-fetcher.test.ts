import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingFetcher } from "../packages/release/src/receipt";
import { DownloadHTTPError } from "tuf-js/dist/error";

test("injected desktop transport retains TUF length bounds, root receipts and HTTP retry semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-update-transport-"));
  try {
    let calls = 0;
    const fetcher = new RecordingFetcher(directory, async (_url, options) => {
      assert.ok(options?.signal);
      calls++;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response("signed-root");
    });
    assert.equal(
      (
        await fetcher.downloadBytes("https://updates.example/2.root.json", 100)
      ).toString(),
      "signed-root",
    );
    assert.equal(calls, 2);
    assert.equal(
      await readFile(join(directory, "2.json"), "utf8"),
      "signed-root",
    );
    await assert.rejects(
      fetcher.downloadBytes("https://updates.example/target", 1),
      /Max length/,
    );
    let missingCalls = 0;
    const missing = new RecordingFetcher(directory, async () => {
      missingCalls++;
      return new Response("missing", { status: 404 });
    });
    await assert.rejects(
      missing.downloadBytes("https://updates.example/3.root.json", 100),
      (error: unknown) =>
        error instanceof DownloadHTTPError && error.statusCode === 404,
    );
    assert.equal(missingCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
