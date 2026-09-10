import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Metadata, MetadataKind } from "@tufjs/models";
import {
  createPublisherRoot,
  roleSigner,
  preparePublisher,
  signPublisherTargets,
  finalizePublisher,
  readPublisherRepository,
  type SigningRole,
} from "../packages/release/src/publisher";
import {
  validateRelease,
  validateReleaseManifest,
} from "../packages/release/src/loader";
import type { ReleaseSet } from "../packages/contracts/src/index";
const keys = () =>
  Object.fromEntries(
    (["root", "targets", "snapshot", "timestamp"] as SigningRole[]).map(
      (role) => [role, roleSigner(generateKeyPairSync("ed25519").privateKey)],
    ),
  ) as Record<SigningRole, ReturnType<typeof roleSigner>>;
const publicKeys = (signers: ReturnType<typeof keys>) =>
  Object.fromEntries(
    Object.entries(signers).map(([role, signer]) => [role, signer.key]),
  ) as Parameters<typeof createPublisherRoot>[0];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "flowgate-publisher-"));
  const signers = keys(),
    root = createPublisherRoot(publicKeys(signers), signers.root);
  const bootstrap = join(directory, "bootstrap"),
    artifacts = join(directory, "artifacts");
  await mkdir(join(bootstrap, "metadata"), { recursive: true });
  for (const name of ["root.json", "1.root.json"])
    await writeFile(
      join(bootstrap, "metadata", name),
      JSON.stringify(root.toJSON()),
    );
  await mkdir(artifacts);
  const content = "export {};";
  await writeFile(join(artifacts, "entry.js"), content);
  const manifest: ReleaseSet = {
    id: "release-one",
    version: 1,
    channel: "preview",
    platforms: [process.platform === "darwin" ? "linux-x64" : "darwin-arm64"],
    shellApi: { min: 2, max: 2 },
    protocol: 1,
    schema: { min: 2, max: 2 },
    ui: "entry.js",
    service: "entry.js",
    extension: "entry.js",
    catalogVersion: 1,
    builtins: [],
    files: {
      "entry.js": {
        size: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    },
  };
  const publish = async (
    base: string,
    name: string,
    change: Parameters<typeof preparePublisher>[3],
    use = signers,
    update?: typeof root,
  ) => {
    const request = join(directory, name + "-request"),
      output = join(directory, name);
    await preparePublisher(base, request, root, change, update);
    await signPublisherTargets(request, root, use.targets);
    await finalizePublisher(request, output, root, use, false, base);
    return output;
  };
  return { directory, root, signers, bootstrap, artifacts, manifest, publish };
}
test("publisher separates roles, publishes immutable targets, promotes, renews, revokes and rotates through authenticated metadata", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        createPublisherRoot(
          { ...publicKeys(f.signers), timestamp: f.signers.root.key },
          f.signers.root,
        ),
      /separate keys/,
    );
    assert.throws(() => validateRelease(f.manifest), /平台/);
    assert.doesNotThrow(() => validateReleaseManifest(f.manifest));
    assert.throws(
      () =>
        validateRelease({
          ...f.manifest,
          platforms: [process.platform + "-" + process.arch],
        }),
      /目录不完整/,
    );
    const future = JSON.parse(
      JSON.stringify({
        ...f.manifest,
        protocol: 2,
        shellApi: { min: 2, max: 3 },
        schema: { min: 2, max: 2 },
        catalogVersion: 2,
      }),
    );
    assert.doesNotThrow(() => validateReleaseManifest(future));
    assert.throws(() => validateRelease(future), /不兼容/);
    assert.throws(
      () =>
        validateReleaseManifest({
          ...f.manifest,
          builtins: [
            { id: "legacy", version: "1", permissions: ["unsafe whitespace"] },
          ],
        }),
      /能力声明/,
    );

    assert.throws(
      () => validateReleaseManifest({ ...f.manifest, platforms: [] }),
      /平台/,
    );
    const first = await f.publish(f.bootstrap, "first", {
      kind: "release",
      manifest: f.manifest,
      artifacts: f.artifacts,
    });
    const a = await readPublisherRepository(first, f.root);
    assert.ok(a.targets.signed.targets["preview/release.json"]);
    assert.ok(!a.targets.signed.targets["stable/release.json"]);
    const promoted = await f.publish(first, "promoted", {
      kind: "promote",
      id: f.manifest.id,
    });
    const b = await readPublisherRepository(promoted, f.root);
    assert.equal(
      b.targets.signed.targets["release-one/entry.js"].hashes.sha256,
      f.manifest.files["entry.js"].sha256,
    );
    assert.ok(b.targets.signed.targets["stable/release.json"]);
    const renewed = join(f.directory, "renewed");
    await finalizePublisher(promoted, renewed, f.root, f.signers, true);
    assert.equal(
      (await readPublisherRepository(renewed, f.root)).timestamp!.signed
        .version,
      3,
    );
    const rotatedSigners = keys();
    const nextRoot = createPublisherRoot(
      publicKeys(rotatedSigners),
      rotatedSigners.root,
      { root: f.root, signer: f.signers.root },
    );
    const rotated = await f.publish(
      renewed,
      "rotated",
      { kind: "refresh-targets" },
      rotatedSigners,
      nextRoot,
    );
    const c = await readPublisherRepository(rotated, f.root);
    assert.equal(c.root.signed.version, 2);
    assert.ok(await readFile(join(rotated, "metadata/1.root.json")));
    const revoked = await f.publish(
      rotated,
      "revoked",
      { kind: "revoke", ids: [f.manifest.id] },
      rotatedSigners,
    );
    const d = await readPublisherRepository(revoked, f.root);
    assert.ok(!d.targets.signed.targets["stable/release.json"]);
    assert.ok(!d.targets.signed.targets["preview/release.json"]);
    assert.ok(!d.targets.signed.targets["release-one/entry.js"]);
    assert.ok(d.targets.signed.targets["releases/release-one.json"]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("publisher rejects role confusion, reused release identities, stale signing events and modified immutable records", async () => {
  const f = await fixture();
  try {
    const request = join(f.directory, "request");
    await preparePublisher(f.bootstrap, request, f.root, {
      kind: "release",
      manifest: f.manifest,
      artifacts: f.artifacts,
    });
    await assert.rejects(
      signPublisherTargets(request, f.root, f.signers.timestamp),
      /not authorized/,
    );
    await signPublisherTargets(request, f.root, f.signers.targets);
    const first = join(f.directory, "first");
    await finalizePublisher(
      request,
      first,
      f.root,
      f.signers,
      false,
      f.bootstrap,
    );
    await assert.rejects(
      preparePublisher(first, join(f.directory, "reuse"), f.root, {
        kind: "release",
        manifest: f.manifest,
        artifacts: f.artifacts,
      }),
      /immutable/,
    );
    const stale = join(f.directory, "stale");
    await preparePublisher(first, stale, f.root, {
      kind: "promote",
      id: f.manifest.id,
    });
    await signPublisherTargets(stale, f.root, f.signers.targets);
    const renewed = join(f.directory, "renewed");
    await finalizePublisher(first, renewed, f.root, f.signers, true);
    await assert.rejects(
      finalizePublisher(
        stale,
        join(f.directory, "bad"),
        f.root,
        f.signers,
        false,
        renewed,
      ),
      /stale/,
    );
    const tampered = Metadata.fromJSON(
      MetadataKind.Targets,
      JSON.parse(await readFile(join(stale, "signing/targets.json"), "utf8")),
    );
    delete tampered.signed.targets["releases/release-one.json"];
    await writeFile(
      join(stale, "signing/targets.json"),
      JSON.stringify(tampered.toJSON()),
    );
    await assert.rejects(
      signPublisherTargets(stale, f.root, f.signers.targets),
      /cannot be removed/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
