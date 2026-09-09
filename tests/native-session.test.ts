import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSession } from "../packages/shell/src/native-session";

test("native transport pipe failure rejects pending writes without crashing the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-broken-pipe-"));
  const script = join(directory, "bridge.sh");
  await writeFile(
    script,
    `
    IFS= read -r request
    id=$(printf '%s' "$request" | sed -E 's/.*"id":"([^"]+)".*/\\1/')
    exec 0<&-
    printf '{"id":"%s","result":{"status":"stopped","systemControl":false}}\\n' "$id"
    exec /bin/sleep 30
  `,
  );
  const session = new NativeSession("/bin/sh", script, directory);
  try {
    await session.start();
    await assert.rejects(session.apply({}, 1, "broken-pipe"), {
      outcome: "unknown",
    });
    assert.equal((await session.status()).status, "unknown");
    await assert.rejects(session.apply({}, 2, "after-failure"));
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
