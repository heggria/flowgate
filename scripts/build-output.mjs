import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Serialize promotion, build in isolation, and restore the previous output if promotion fails.
export async function withBuildOutput(build, root = process.cwd()) {
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const lock = join(work, "build.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another build holds work/build.lock; wait for it to finish. After an interrupted build, verify its PID before removing that lock.",
      );
    throw error;
  }
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  let staging;
  let previous;
  let promoted = false;
  try {
    staging = await mkdtemp(join(work, "build-"));
    await build(staging);
    const output = resolve(root, "dist");
    previous = staging + "-previous";
    try {
      await rename(output, previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      previous = undefined;
    }
    try {
      await rename(staging, output);
    } catch (error) {
      if (previous) {
        await rename(previous, output);
        previous = undefined;
      }
      throw error;
    }
    staging = undefined;
    promoted = true;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (previous && promoted)
      await rm(previous, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
