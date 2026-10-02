import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("recovery shell status and restore failures are visible and release disabled buttons", async () => {
  const elements = Object.fromEntries(
    ["message", "result", "disconnect", "restore"].map((id) => [
      id,
      {
        textContent: "",
        disabled: false,
        onclick: undefined as undefined | (() => Promise<void>),
      },
    ]),
  );
  runInNewContext(readFileSync("src/desktop/recovery.js", "utf8"), {
    document: {
      getElementById: (id: string) => elements[id],
      querySelectorAll: () => [elements.disconnect, elements.restore],
    },
    window: {
      shell: {
        request: async () => {
          throw Error("https://private:secret@example.com failed");
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.message.textContent, /无法读取恢复状态/);
  assert.equal(elements.message.textContent.includes("private:secret"), false);
  await elements.restore.onclick?.();
  assert.match(elements.result.textContent, /操作未完成/);
  assert.equal(elements.restore.disabled, false);
  assert.equal(elements.disconnect.disabled, false);
  assert.equal(elements.result.textContent.includes("private:secret"), false);
});
