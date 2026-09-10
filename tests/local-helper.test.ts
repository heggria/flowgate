import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authorizationScript } from "../packages/shell/src/local-helper";
const exec = promisify(execFile);
test("administrator command preserves literal paths across AppleScript and shell parsing", async () => {
  const values = [
    "a b",
    "a'b",
    'a"b',
    "$(exit 17)",
    "`exit 18`",
    "back\\slash",
    "line\nbreak",
  ];
  const script = authorizationScript(["/usr/bin/printf", "%s\\n", ...values]);
  const literal = script
    .split(" do shell script ")[1]
    .split(" with administrator privileges")[0];
  const command = (
    await exec("/usr/bin/osascript", ["-e", "return " + literal])
  ).stdout.trimEnd();
  const result = await exec("/bin/sh", ["-c", command]);
  assert.equal(result.stdout, values.join("\n") + "\n");
});
