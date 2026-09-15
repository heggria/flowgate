import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { NativeSession } from "../packages/shell/src/native-session";

test("failed native cleanup still releases the bridge input lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-close-"));
  const bridge = join(dir, "bridge.cjs");
  await writeFile(
    bridge,
    `#!/usr/bin/env node
const readline = require('node:readline');
const reader = readline.createInterface({input:process.stdin});
reader.on('line', line => {
 const request=JSON.parse(line);
 console.log(JSON.stringify(request.method==='stop'
  ? {id:request.id,error:'cleanup still pending'}
  : {id:request.id,result:{status:'stopped',systemControl:false}}));
});
reader.on('close',()=>process.exit(0));
`,
  );
  await chmod(bridge, 0o755);
  const native = new NativeSession(bridge, "unused", dir);
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await native.start();
    child = (native as unknown as { process: ChildProcess }).process;
    const exited = new Promise<boolean>((resolve) => {
      child!.once("exit", () => resolve(true));
      timer = setTimeout(() => resolve(false), 1500);
    });
    await assert.rejects(native.close(), /cleanup still pending/);
    assert.equal(
      await exited,
      true,
      "failed stop must not leave the bridge waiting forever on stdin",
    );
  } finally {
    clearTimeout(timer);
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
