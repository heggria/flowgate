import {
  Metadata,
  Root,
  Targets,
  Snapshot,
  Timestamp,
  MetaFile,
  TargetFile,
  Key,
  Signature,
} from "@tufjs/models";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
// Ephemeral test-only keys. Official publishing keeps role keys outside the build workspace.
export function fixtureRepository(targets) {
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
  const signer = (data) =>
    new Signature({
      keyID,
      sig: sign(null, data, pair.privateKey).toString("hex"),
    });
  const common = {
    version: 1,
    specVersion: "1.0.0",
    expires: new Date(Date.now() + 86400000).toISOString(),
  };
  const targetsMeta = new Metadata(new Targets(common));
  for (const target of targets) {
    const content = Buffer.from(target.content);
    targetsMeta.signed.addTarget(
      new TargetFile({
        path: target.name,
        length: content.length,
        hashes: { sha256: createHash("sha256").update(content).digest("hex") },
      }),
    );
  }
  targetsMeta.sign(signer);
  const meta = (metadata) => {
    const content = JSON.stringify(metadata.toJSON());
    return new MetaFile({
      version: 1,
      length: Buffer.byteLength(content),
      hashes: { sha256: createHash("sha256").update(content).digest("hex") },
    });
  };
  const snapshotMeta = new Metadata(
    new Snapshot({ ...common, meta: { "targets.json": meta(targetsMeta) } }),
  );
  snapshotMeta.sign(signer);
  const timestampMeta = new Metadata(
    new Timestamp({ ...common, snapshotMeta: meta(snapshotMeta) }),
  );
  timestampMeta.sign(signer);
  const rootMeta = new Metadata(
    new Root({ ...common, consistentSnapshot: false }),
  );
  for (const role of ["root", "targets", "snapshot", "timestamp"])
    rootMeta.signed.addKey(key, role);
  rootMeta.sign(signer);
  return { rootMeta, targetsMeta, snapshotMeta, timestampMeta, targets };
}
