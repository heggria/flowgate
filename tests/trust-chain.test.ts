import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Metadata,
  Root,
  Key,
  Signature,
  Targets,
  TargetFile,
} from "@tufjs/models";
import { trustedRoot, verifyReceipt } from "../packages/release/src/receipt";
function identity() {
  const pair = generateKeyPairSync("ed25519");
  const publicHex = pair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex");
  const keyID = createHash("sha256").update(publicHex).digest("hex");
  const key = new Key({
    keyID,
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: { public: publicHex },
  });
  return {
    key,
    signer: (bytes: Buffer) =>
      new Signature({
        keyID,
        sig: sign(null, bytes, pair.privateKey).toString("hex"),
      }),
  };
}
test("root rotation requires both old and new role authorization; offline receipts preserve trusted code after expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowgate-trust-"));
  try {
    const old = identity(),
      next = identity();
    const root = (version: number, who: ReturnType<typeof identity>) => {
      const metadata = new Metadata(
        new Root({
          specVersion: "1.0.0",
          version,
          expires: new Date(Date.now() + 86400000).toISOString(),
        }),
      );
      for (const role of ["root", "targets", "snapshot", "timestamp"])
        metadata.signed.addKey(who.key, role);
      metadata.sign(who.signer);
      return metadata;
    };
    const first = root(1, old),
      rotated = root(2, next);
    const rootPath = join(dir, "root.json"),
      rotationPath = join(dir, "2.json");
    await writeFile(rootPath, JSON.stringify(first.toJSON()));
    await writeFile(rotationPath, JSON.stringify(rotated.toJSON()));
    await assert.rejects(
      () => trustedRoot(rootPath, dir, 2),
      "new key alone cannot rotate trust",
    );
    rotated.sign(old.signer, true);
    await writeFile(rotationPath, JSON.stringify(rotated.toJSON()));
    assert.equal((await trustedRoot(rootPath, dir, 2)).signed.version, 2);
    await assert.rejects(
      () => trustedRoot(rootPath, dir, 3),
      "missing intermediate root denied",
    );
    const bytes = Buffer.from(JSON.stringify({ id: "verified-before-expiry" }));
    const targets = new Metadata(
      new Targets({
        specVersion: "1.0.0",
        version: 1,
        expires: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    targets.signed.addTarget(
      new TargetFile({
        path: "stable/release.json",
        length: bytes.length,
        hashes: { sha256: createHash("sha256").update(bytes).digest("hex") },
      }),
    );
    targets.sign(next.signer);
    const receipt = {
      rootVersion: 2,
      targets: targets.toJSON(),
      manifestTarget: "stable/release.json",
      manifestBytes: bytes.toString("base64"),
    };
    await assert.rejects(
      () => verifyReceipt(receipt, rootPath, dir, true),
      /过期/,
    );
    assert.equal(
      (await verifyReceipt(receipt, rootPath, dir, false)).id,
      "verified-before-expiry",
    );
    targets.sign(old.signer, false);
    receipt.targets = targets.toJSON();
    await assert.rejects(
      () => verifyReceipt(receipt, rootPath, dir, false),
      "retired key cannot sign current targets",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
