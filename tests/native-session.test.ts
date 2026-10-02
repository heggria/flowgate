import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, readFile } from "node:fs/promises";
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

test("explicit recovery rebuilds a lost bridge once, stops safely, and never replays apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-reconnect-"));
  const bridge = join(directory, "bridge.cjs");
  const calls = join(directory, "calls.jsonl");
  await writeFile(
    bridge,
    `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'spawn'})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');
 const result={status:q.method==='apply'?'running':'stopped',systemControl:false,operationId:q.payload?.operationId};
 setTimeout(()=>console.log(JSON.stringify({id:q.id,result})),25);
});
`,
  );
  await chmod(bridge, 0o755);
  const native = new NativeSession(bridge, "unused", directory);
  try {
    await native.start();
    const child = (native as any).process;
    const exited = new Promise<void>((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    await assert.rejects(native.apply({}, 1, "do-not-replay"));
    const [a, b] = await Promise.all([
      native.recoverStop("recovery"),
      native.recoverStop("recovery"),
    ]);
    assert.equal(a.status, "stopped");
    assert.equal(a.operationId, "recovery");
    assert.deepEqual(a, b);
    const requests = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.equal(requests.filter((q) => q.method === "spawn").length, 2);
    assert.equal(requests.filter((q) => q.method === "stop").length, 1);
    assert.equal(requests.filter((q) => q.method === "apply").length, 0);
    await native.apply({}, 2, "user-reconnect");
    native.setSuspended(true);
    await assert.rejects(native.recoverStop("suspended"), /暂停/);
    native.setSuspended(false);
    const recovery = native.recoverStop("closing");
    const closing = native.close();
    await assert.rejects(recovery, /关闭/);
    await closing;
    await assert.rejects(native.recoverStop("closed"), /关闭/);
  } finally {
    await native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "transport recovery waits for the retired bridge to exit before opening a new writer",
  { timeout: 5000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "flowgate-retire-transport-"),
    );
    const bridge = join(directory, "bridge.cjs");
    await writeFile(
      bridge,
      `#!/bin/sh
directory=$2
generation=0
if [ -f "$directory/generation" ]; then IFS= read -r generation < "$directory/generation"; fi
generation=$((generation+1))
printf '%s' "$generation" > "$directory/generation"
if [ "$generation" -eq 1 ]; then
 IFS= read -r request
 id=$(printf '%s' "$request" | sed -E 's/.*"id":"([^"]+)".*/\\1/')
 exec 0<&-
 trap 'sleep 0.5; exit 0' TERM
 printf '{"id":"%s","result":{"status":"stopped","systemControl":false}}\\n' "$id"
 while :; do sleep 0.1; done
else
 exec /usr/bin/env node "$directory/replacement.cjs"
fi
`,
    );
    await writeFile(
      join(directory, "replacement.cjs"),
      `
const readline=require('node:readline');
const reader=readline.createInterface({input:process.stdin});
reader.on('line',line=>{
 const q=JSON.parse(line);
 const result={status:q.method==='apply'?'running':'stopped',systemControl:false,operationId:q.payload?.operationId};
 console.log(JSON.stringify({id:q.id,result}));
});
reader.on('close',()=>process.exit(0));
`,
    );
    await chmod(bridge, 0o755);
    const native = new NativeSession(bridge, "unused", directory);
    let oldChild: import("node:child_process").ChildProcess | undefined;
    try {
      await native.start();
      oldChild = (native as any).process;
      await assert.rejects(native.apply({}, 1, "lost-apply"), {
        outcome: "unknown",
      });
      const recovered = await native.recoverStop("transport-recovery");
      assert.ok(oldChild!.exitCode !== null || oldChild!.signalCode !== null);
      assert.notEqual((native as any).process, oldChild);
      assert.equal(recovered.status, "stopped");
      assert.equal(recovered.operationId, "transport-recovery");
      assert.equal(
        (await native.apply({}, 2, "explicit-reconnect")).status,
        "running",
      );
      await native.close();
    } finally {
      oldChild?.kill("SIGKILL");
      await native.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);
