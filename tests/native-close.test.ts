import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
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

async function recoveryFixture(privileged = false) {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-close-recovery-"));
  const bridge = join(dir, "bridge.cjs");
  const calls = join(dir, "calls.jsonl");
  const privilege = join(dir, "privileged");
  await writeFile(
    bridge,
    `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const directory=process.argv[3],count=directory+'/generation';
const generation=Number(fs.existsSync(count)?fs.readFileSync(count,'utf8'):0)+1;
fs.writeFileSync(count,String(generation));
const calls=${JSON.stringify(calls)},privilege=${JSON.stringify(privilege)};
let state={status:generation===1?'running':'stopped',systemControl:generation===1?${privileged}:false};
let statusCalls=0,late;
const reply=(q,result)=>console.log(JSON.stringify({id:q.id,result}));
const reader=readline.createInterface({input:process.stdin});
reader.on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(calls,JSON.stringify({generation,...q})+'\\n');
 if(generation===1&&q.method==='status'&&++statusCalls>1){late=q;return;}
 if(generation===1&&q.method==='stop'){console.log(JSON.stringify({id:q.id,error:'cleanup still pending'}));return;}
 if(q.method==='stop')state={status:'stopped',systemControl:fs.existsSync(privilege),operationId:q.payload.operationId};
 if(q.method==='apply')state={status:'running',systemControl:generation===1?${privileged}:fs.existsSync(privilege),operationId:q.payload.operationId};
 reply(q,state);
});
reader.on('close',()=>{
 if(generation!==1){process.exit(0);return;}
 setTimeout(()=>{if(late)reply(late,{status:'running',systemControl:${privileged},operationId:'retired-generation'});},300);
 setTimeout(()=>process.exit(0),700);
});
`,
  );
  await chmod(bridge, 0o755);
  return {
    dir,
    privilege,
    native: new NativeSession(bridge, "unused", dir),
    async requests() {
      return (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

test(
  "failed close retires its generation, permits explicit recovery, and can close again",
  { timeout: 5000 },
  async () => {
    const fixture = await recoveryFixture();
    const { native, dir } = fixture;
    let oldChild: ChildProcess | undefined;
    try {
      await native.start();
      oldChild = (native as any).process;
      const exited = new Promise<void>((resolve) =>
        oldChild!.once("exit", () => resolve()),
      );
      const oldStatus = native.status();
      const deadline = Date.now() + 1500;
      while (
        (await fixture.requests()).filter((q) => q.method === "status").length <
        2
      ) {
        assert.ok(
          Date.now() < deadline,
          "old generation received the pending status request",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await assert.rejects(native.close(), /cleanup still pending/);
      assert.equal((await native.status()).status, "unknown");
      await assert.rejects(native.apply({}, 2, "before-recovery"), {
        outcome: "unknown",
      });
      const recovered = await native.recoverStop("after-failed-close");
      assert.equal(recovered.status, "stopped");
      assert.equal(recovered.operationId, "after-failed-close");
      assert.ok(
        oldChild!.exitCode !== null || oldChild!.signalCode !== null,
        "the old journal writer must exit before the replacement recovers",
      );
      assert.notEqual(
        (native as any).process,
        oldChild,
        "EOF generation must be retired before recovery starts",
      );
      assert.equal(
        (await oldStatus).status,
        "unknown",
        "pending old requests must not accept late responses",
      );
      await native.apply({}, 3, "explicit-reconnect");
      await exited;
      const current = await native.status();
      assert.equal(current.status, "running");
      assert.equal(current.operationId, "explicit-reconnect");
      assert.deepEqual(
        (await fixture.requests())
          .filter((q) => q.method === "apply")
          .map((q) => q.payload.operationId),
        ["explicit-reconnect"],
      );
      await native.close();
      await native.close();
      await assert.rejects(native.start(), /关闭/);
      await assert.rejects(
        native.recoverStop("after-successful-close"),
        /关闭/,
      );
      await assert.rejects(native.apply({}, 4, "after-successful-close"), {
        outcome: "unknown",
      });
    } finally {
      oldChild?.kill();
      await native.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "failed privileged close cannot recover through manual stopped fallback",
  { timeout: 5000 },
  async () => {
    const { native, dir, privilege } = await recoveryFixture(true);
    let oldChild: ChildProcess | undefined;
    try {
      await native.start();
      oldChild = (native as any).process;
      await native.apply({}, 1, "old-privileged-connection", "system");
      await assert.rejects(native.close(), /cleanup still pending/);
      await assert.rejects(native.recoverStop("manual-fallback"), {
        outcome: "unknown",
      });
      assert.equal((await native.status()).status, "unknown");
      await assert.rejects(native.apply({}, 2, "unsafe-reconnect"), {
        outcome: "unknown",
      });
      await writeFile(privilege, "approved helper available");
      const recovered = await native.recoverStop("privileged-recovery");
      assert.equal(recovered.status, "stopped");
      assert.equal(recovered.systemControl, true);
      assert.equal(recovered.operationId, "privileged-recovery");
      await native.apply({}, 3, "explicit-privileged-reconnect", "system");
      await native.close();
      await assert.rejects(native.start(), /关闭/);
    } finally {
      oldChild?.kill();
      await native.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
