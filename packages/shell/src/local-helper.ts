import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const exec = promisify(execFile);

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function authorizationScript(args: string[]) {
  const command = args.map(shellQuote).join(" ");
  // AppleScript string quoting is separate from shell argument quoting.
  const literal =
    '"' + command.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  return `with timeout of 300 seconds\n do shell script ${literal} with administrator privileges\nend timeout`;
}

export async function manageLocalHelper(
  directory: string,
  action: "install" | "uninstall",
) {
  const args = [join(directory, "flowgate-local-installer"), action];
  if (action === "install") {
    const uid = process.getuid?.();
    if (uid === undefined || uid < 501)
      throw new Error("请使用本机普通用户安装辅助服务");
    args.push(directory, String(uid));
    for (const file of ["flowgate-bridge", "flowgate-helper", "sing-box"])
      args.push(
        createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex"),
      );
  }
  try {
    await exec("/usr/bin/osascript", ["-e", authorizationScript(args)], {
      timeout: 310_000,
      maxBuffer: 64_000,
    });
  } catch (error: any) {
    const message = String(error.stderr ?? error.message);
    if (message.includes("-128"))
      throw new Error("已取消管理员授权，辅助服务未变更");
    if (error.killed || message.includes("-1712"))
      throw new Error("管理员授权或安装超时，请检查辅助服务状态后重试");
    throw new Error("辅助服务操作失败：" + message.slice(0, 800));
  }
}
