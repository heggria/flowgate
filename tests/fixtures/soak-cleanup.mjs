import assert from "node:assert/strict";

export async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cleanup deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Capture the child handle and inspector identity while the automation link works.
// A closed Playwright context alone does not prove this process has exited.
export async function captureSoakProcess(app, data, executablePath) {
  const child = app.process();
  assert.ok(child?.pid, "Soak requires a locally owned child process");
  const identity = await app.evaluate(() => ({
    pid: process.pid,
    data: process.env.FLOWGATE_TEST_DATA,
    executablePath: process.execPath,
    inspector: process.mainModule.require("node:inspector").url(),
  }));
  assert.equal(identity.pid, child.pid);
  assert.equal(identity.data, data);
  assert.equal(identity.executablePath, executablePath);
  const endpoint = new URL(identity.inspector);
  assert.equal(endpoint.protocol, "ws:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const isExited = () => child.exitCode !== null || child.signalCode !== null;
  const waitForExit = async (milliseconds) => {
    if (isExited()) return true;
    await within(exited, milliseconds).catch(() => {});
    return isExited();
  };
  return { child, identity, waitForExit, isExited };
}

async function inspectorQuit({ identity }) {
  const socket = new WebSocket(identity.inspector);
  try {
    await within(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("Inspector unavailable")),
          { once: true },
        );
      }),
      3000,
    );
    await within(
      new Promise((resolve, reject) => {
        socket.addEventListener("message", (event) => {
          const response = JSON.parse(event.data);
          if (response.id !== 1) return;
          if (
            response.error ||
            response.result?.exceptionDetails ||
            response.result?.result?.value !== true
          )
            reject(new Error("Inspector quit identity check failed"));
          else resolve();
        });
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: `(() => {
            const expected = ${JSON.stringify(identity)};
            if (process.pid !== expected.pid || process.execPath !== expected.executablePath || process.env.FLOWGATE_TEST_DATA !== expected.data)
              throw Error("Isolated process identity mismatch");
            setTimeout(() => process.mainModule.require("electron").app.quit(), 50);
            return true;
          })()`,
              returnByValue: true,
            },
          }),
        );
      }),
      3000,
    );
  } finally {
    socket.close();
  }
}

export async function closeSoakApp(app, owned) {
  const result = {
    method: "playwright",
    pid: owned?.child.pid,
    processExited: false,
    graceful: true,
    errors: [],
  };
  if (!app) return { ...result, method: "not-launched", processExited: true };
  try {
    await within(app.close(), 10000);
  } catch (error) {
    result.errors.push(String(error.message).slice(0, 300));
  }
  if (!owned)
    return {
      ...result,
      graceful: false,
      errors: [...result.errors, "Child identity was not captured"],
    };
  if (await owned.waitForExit(1000)) return { ...result, processExited: true };
  result.method = "inspector-app-quit";
  try {
    await inspectorQuit(owned);
  } catch (error) {
    result.errors.push(String(error.message).slice(0, 300));
  }
  if (await owned.waitForExit(10000)) return { ...result, processExited: true };
  // This is the original ChildProcess handle, never a PID recovered from a report.
  // Forced cleanup is always reported as a failure of graceful shutdown.
  result.graceful = false;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    result.method = signal;
    if (!owned.isExited()) owned.child.kill(signal);
    if (await owned.waitForExit(5000))
      return { ...result, processExited: true };
  }
  return result;
}
