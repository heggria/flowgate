import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withBuildOutput } from "../scripts/build-output.mjs";
import {
  inventory,
  sealArtifacts,
  verifyArtifacts,
} from "../scripts/artifacts.mjs";
import { boundaryViolations } from "../scripts/check-boundaries.mjs";

test("failed builds preserve previous output; successful builds remove stale files and serialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowgate-build-"));
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist/old"), "accepted");
    await assert.rejects(
      withBuildOutput(async (stage) => {
        await writeFile(join(stage, "partial"), "bad");
        throw new Error("compile failed");
      }, root),
    );
    assert.equal(await readFile(join(root, "dist/old"), "utf8"), "accepted");
    await withBuildOutput(async (stage) => {
      await assert.rejects(
        withBuildOutput(async () => {}, root),
        /Another build/,
      );
      await writeFile(join(stage, "new"), "complete");
    }, root);
    await assert.rejects(access(join(root, "dist/old")));
    assert.equal(await readFile(join(root, "dist/new"), "utf8"), "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("packaging rejects missing, altered and unexpected files", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowgate-inventory-"));
  try {
    await mkdir(join(root, "release"));
    await mkdir(join(root, "assets"));
    for (const file of [
      "main.cjs",
      "preload.cjs",
      "assets/FlowGate.icns",
      "assets/menuBarTemplate.png",
      "assets/menuBarTemplate@2x.png",
      "assets/app-icon.png",
      "verification.cjs",
      "sing-box",
      "flowgate-bridge",
      "flowgate-helper",
      "release/index.html",
      "release/service.cjs",
    ])
      await writeFile(join(root, file), "fixture");
    await sealArtifacts(root, { version: "0.2.0" });
    await verifyArtifacts(root);
    await writeFile(join(root, "stale-secret.txt"), "not for distribution");
    await assert.rejects(verifyArtifacts(root));
    await rm(join(root, "stale-secret.txt"));
    await writeFile(join(root, "main.cjs"), "modified");
    await assert.rejects(verifyArtifacts(root));
    await rm(join(root, "sing-box"));
    await assert.rejects(sealArtifacts(root, {}), /missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("architecture boundaries cover imports, re-exports, require and package aliases", () => {
  for (const code of [
    'import fs from "node:fs"',
    'const fs = require("node:fs")',
    'export * from "fs/promises"',
    'import fs = require("fs")',
    'import("node:net")',
    "require(variable)",
    'import x from "@flowgate/service"',
  ])
    assert.ok(boundaryViolations("src/ui/example.ts", code).length, code);
  assert.ok(
    boundaryViolations(
      "packages/shell/src/a.ts",
      'import x from "@flowgate/domain"',
    ).length,
  );
  assert.deepEqual(
    boundaryViolations(
      "src/ui/a.ts",
      'import type { X } from "../../packages/contracts/src/index"; import React from "react"',
    ),
    [],
  );
  assert.deepEqual(
    boundaryViolations("packages/service/src/a.ts", 'import fs from "node:fs"'),
    [],
  );
});
