import { isDeepStrictEqual } from "node:util";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep, basename } from "node:path";
import {
  Key,
  Metadata,
  MetadataKind,
  Root,
  Targets,
  Snapshot,
  Timestamp,
  MetaFile,
  TargetFile,
  Signature,
} from "@tufjs/models";
import type { ReleaseSet } from "../../contracts/src/index";
import { validateReleaseManifest, verifyPublishedDirectory } from "./loader";
export type SigningRole = "root" | "targets" | "snapshot" | "timestamp";
export interface RoleSigner {
  key: Key;
  sign(data: Buffer): Signature;
}
const roles: SigningRole[] = ["root", "targets", "snapshot", "timestamp"];
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (metadata: Metadata<any>) =>
  Buffer.from(JSON.stringify(metadata.toJSON()));
const expires = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString();
const common = (version: number, days: number) => ({
  version,
  specVersion: "1.0.0",
  expires: expires(days),
});
export function roleSigner(privateKey: KeyObject): RoleSigner {
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  )
    throw new Error("Publisher requires Ed25519 private keys");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const publicHex = Buffer.from(jwk.x!, "base64url").toString("hex");
  // TUF key IDs hash the canonical public-key object, not private material.
  const keyID = sha256(
    Buffer.from(
      JSON.stringify({
        keytype: "ed25519",
        keyval: { public: publicHex },
        scheme: "ed25519",
      }),
    ),
  );
  const key = new Key({
    keyID,
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: { public: publicHex },
  });
  return {
    key,
    sign: (bytes) =>
      new Signature({
        keyID,
        sig: sign(null, bytes, privateKey).toString("hex"),
      }),
  };
}
export async function loadRoleSigner(
  path: string,
  workspace: string,
  passphrase?: string,
): Promise<RoleSigner> {
  const actual = await realpath(path),
    project = await realpath(workspace);
  if (actual === project || actual.startsWith(project + sep))
    throw new Error("Signing keys must stay outside the build checkout");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16384
  )
    throw new Error("Signing key must be a private regular file (mode 0600)");
  return roleSigner(
    createPrivateKey({
      key: await readFile(actual),
      format: "pem",
      passphrase,
    }),
  );
}
function verifyRole(
  root: Metadata<Root>,
  role: SigningRole,
  metadata: Metadata<any>,
) {
  root.verifyDelegate(role, metadata);
}
function signRole(
  root: Metadata<Root>,
  role: SigningRole,
  metadata: Metadata<any>,
  signer: RoleSigner,
) {
  if (!root.signed.roles[role]?.keyIDs.includes(signer.key.keyID))
    throw new Error("Signer is not authorized for " + role);
  metadata.sign(signer.sign, true);
  verifyRole(root, role, metadata);
}
export function createPublisherRoot(
  keys: Record<SigningRole, Key>,
  signer: RoleSigner,
  previous?: { root: Metadata<Root>; signer: RoleSigner },
): Metadata<Root> {
  if (
    new Set(roles.map((role) => keys[role].keyVal.public)).size !==
      roles.length ||
    roles.some(
      (role) =>
        keys[role].keyType !== "ed25519" || keys[role].scheme !== "ed25519",
    )
  )
    throw new Error(
      "Root, targets, snapshot and timestamp must use separate keys",
    );
  const root = new Metadata(
    new Root({
      ...common((previous?.root.signed.version ?? 0) + 1, 365),
      consistentSnapshot: true,
    }),
  );
  for (const role of roles) root.signed.addKey(keys[role], role);
  signRole(root, "root", root, signer);
  if (previous) {
    verifyRole(previous.root, "root", previous.root);
    root.sign(previous.signer.sign, true);
    verifyRole(previous.root, "root", root);
  }
  return root;
}
async function readSafe(directory: string, name: string): Promise<Buffer> {
  if (
    !/^[\w./-]+$/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid publisher path");
  const root = await realpath(directory),
    path = join(root, name),
    stat = await lstat(path),
    actual = await realpath(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !actual.startsWith(root + sep) ||
    stat.size > 40 * 1024 * 1024
  )
    throw new Error("Unsafe publisher file");
  return readFile(actual);
}
async function immutable(directory: string, name: string, bytes: Buffer) {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await readSafe(directory, name)).equals(bytes)
    )
      throw new Error("Published path cannot be overwritten: " + name);
  }
}
function targetPath(target: TargetFile) {
  if (!/^[a-f0-9]{64}$/.test(target.hashes.sha256))
    throw new Error("SHA-256 target digest required");
  const folder = dirname(target.path);
  return (
    "targets/" +
    (folder === "." ? "" : folder + "/") +
    target.hashes.sha256 +
    "." +
    basename(target.path)
  );
}
async function targetBytes(directory: string, target: TargetFile) {
  const bytes = await readSafe(directory, targetPath(target));
  if (bytes.length !== target.length || sha256(bytes) !== target.hashes.sha256)
    throw new Error("Published target does not match signed metadata");
  return bytes;
}
interface Repository {
  root: Metadata<Root>;
  targets: Metadata<Targets>;
  snapshot?: Metadata<Snapshot>;
  timestamp?: Metadata<Timestamp>;
}
export async function readPublisherRepository(
  directory: string,
  pinned: Metadata<Root>,
): Promise<Repository> {
  verifyRole(pinned, "root", pinned);
  let root = pinned;
  const current = Metadata.fromJSON(
    MetadataKind.Root,
    JSON.parse((await readSafe(directory, "metadata/root.json")).toString()),
  );
  if (
    current.signed.version < pinned.signed.version ||
    current.signed.version > pinned.signed.version + 100
  )
    throw new Error("Invalid publisher root chain");
  for (
    let version = pinned.signed.version + 1;
    version <= current.signed.version;
    version++
  ) {
    const next = Metadata.fromJSON(
      MetadataKind.Root,
      JSON.parse(
        (await readSafe(directory, `metadata/${version}.root.json`)).toString(),
      ),
    );
    if (next.signed.version !== version)
      throw new Error("Non-contiguous root rotation");
    verifyRole(root, "root", next);
    verifyRole(next, "root", next);
    root = next;
  }
  if (!encode(root).equals(encode(current)) || !root.signed.consistentSnapshot)
    throw new Error("Publisher root differs from trusted chain");
  let timestampBytes: Buffer;
  try {
    timestampBytes = await readSafe(directory, "metadata/timestamp.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const names = await readdir(join(directory, "metadata"));
    if (names.some((name) => !/^(?:\d+\.)?root\.json$/.test(name)))
      throw new Error("Published repository is missing its timestamp");
    return {
      root,
      targets: new Metadata(
        new Targets({ ...common(1, 30), expires: root.signed.expires }),
      ),
    };
  }
  const timestamp = Metadata.fromJSON(
    MetadataKind.Timestamp,
    JSON.parse(timestampBytes.toString()),
  );
  verifyRole(root, "timestamp", timestamp);
  const snapshotBytes = await readSafe(
    directory,
    `metadata/${timestamp.signed.snapshotMeta.version}.snapshot.json`,
  );
  timestamp.signed.snapshotMeta.verify(snapshotBytes);
  const snapshot = Metadata.fromJSON(
    MetadataKind.Snapshot,
    JSON.parse(snapshotBytes.toString()),
  );
  verifyRole(root, "snapshot", snapshot);
  if (snapshot.signed.version !== timestamp.signed.snapshotMeta.version)
    throw new Error("Snapshot version mismatch");
  const targetsInfo = snapshot.signed.meta["targets.json"];
  const targetsBytes = await readSafe(
    directory,
    `metadata/${targetsInfo.version}.targets.json`,
  );
  targetsInfo.verify(targetsBytes);
  const targets = Metadata.fromJSON(
    MetadataKind.Targets,
    JSON.parse(targetsBytes.toString()),
  );
  verifyRole(root, "targets", targets);
  if (targets.signed.version !== targetsInfo.version)
    throw new Error("Targets version mismatch");
  for (const target of Object.values(targets.signed.targets))
    await targetBytes(directory, target);
  return { root, targets, snapshot, timestamp };
}
async function copyPublic(source: string, output: string) {
  for (const section of ["metadata", "targets"]) {
    async function walk(relative: string) {
      for (const entry of await readdir(join(source, relative), {
        withFileTypes: true,
      }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const name = relative + "/" + entry.name;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile())
          await immutable(output, name, await readSafe(source, name));
        else throw new Error("Publisher repository cannot contain links");
      }
    }
    await walk(section);
  }
}
export type PublisherChange =
  | { kind: "release"; manifest: ReleaseSet; artifacts: string }
  | { kind: "promote"; id: string }
  | { kind: "revoke"; ids: string[] }
  | { kind: "refresh-targets" };
export async function preparePublisher(
  directory: string,
  output: string,
  pinned: Metadata<Root>,
  change: PublisherChange,
  rootUpdate?: Metadata<Root>,
) {
  const old = await readPublisherRepository(directory, pinned);
  if (rootUpdate) verifyRootTransition(old.root, rootUpdate);
  if ((rootUpdate ?? old.root).signed.isExpired())
    throw new Error("Publisher root expired; rotate/re-sign it offline");
  await mkdir(output); // A signing request never overwrites another request.
  await copyPublic(directory, output);
  const targets = new Metadata(
    new Targets({
      ...common(old.timestamp ? old.targets.signed.version + 1 : 1, 30),
      targets: { ...old.targets.signed.targets },
    }),
  );
  const add = async (name: string, bytes: Buffer) => {
    const target = new TargetFile({
      path: name,
      length: bytes.length,
      hashes: { sha256: sha256(bytes) },
    });
    await immutable(output, targetPath(target), bytes);
    targets.signed.addTarget(target);
  };
  const policyTarget = targets.signed.targets["revocations.json"];
  const policy: { version: number; releases: string[] } = policyTarget
    ? JSON.parse((await targetBytes(directory, policyTarget)).toString())
    : { version: 0, releases: [] };
  if (change.kind === "release") {
    const manifest = change.manifest;
    validateReleaseManifest(manifest);
    await verifyPublishedDirectory(change.artifacts, manifest);
    if (
      targets.signed.targets[`releases/${manifest.id}.json`] ||
      policy.releases.includes(manifest.id)
    )
      throw new Error("Release ID is immutable or revoked");
    for (const [name, target] of Object.entries(targets.signed.targets)) {
      if (name.startsWith("releases/") && name.endsWith(".json")) {
        const existing = JSON.parse(
          (await targetBytes(directory, target)).toString(),
        );
        if (manifest.version <= existing.version)
          throw new Error("Release version must increase monotonically");
      }
    }
    for (const name of Object.keys(manifest.files))
      await add(
        manifest.id + "/" + name,
        await readSafe(change.artifacts, name),
      );
    await add(
      `releases/${manifest.id}.json`,
      Buffer.from(JSON.stringify(manifest)),
    );
    await add(
      manifest.channel + "/release.json",
      Buffer.from(JSON.stringify(manifest)),
    );
  } else if (change.kind === "promote") {
    const target = targets.signed.targets[`releases/${change.id}.json`];
    if (!target || policy.releases.includes(change.id))
      throw new Error("Cannot promote an absent or revoked release");
    const manifest = JSON.parse(
      (await targetBytes(directory, target)).toString(),
    ) as ReleaseSet;
    validateReleaseManifest(manifest);
    const previous = targets.signed.targets["stable/release.json"];
    if (
      previous &&
      JSON.parse((await targetBytes(directory, previous)).toString()).version >
        manifest.version
    )
      throw new Error("Promotion cannot roll stable backward");
    await add(
      "stable/release.json",
      Buffer.from(JSON.stringify({ ...manifest, channel: "stable" })),
    );
  } else if (change.kind === "revoke") {
    if (
      !change.ids.length ||
      change.ids.some((id) => !targets.signed.targets[`releases/${id}.json`])
    )
      throw new Error("Unknown release revocation");
    policy.version++;
    policy.releases = [...new Set([...policy.releases, ...change.ids])];
    for (const channel of ["stable", "preview"]) {
      const pointer = targets.signed.targets[channel + "/release.json"];
      if (
        pointer &&
        policy.releases.includes(
          JSON.parse((await targetBytes(directory, pointer)).toString()).id,
        )
      )
        delete targets.signed.targets[channel + "/release.json"];
    }
    for (const name of Object.keys(targets.signed.targets))
      if (change.ids.some((id) => name.startsWith(id + "/")))
        delete targets.signed.targets[name];
  }
  if (!policyTarget || change.kind === "revoke")
    await add("revocations.json", Buffer.from(JSON.stringify(policy)));
  await mkdir(join(output, "signing"));
  if (rootUpdate)
    await writeFile(join(output, "signing/root.json"), encode(rootUpdate), {
      flag: "wx",
    });
  await writeFile(join(output, "signing/targets.json"), encode(targets), {
    flag: "wx",
  });
  return {
    version: targets.signed.version,
    targets: Object.keys(targets.signed.targets).length,
  };
}
function verifyRootTransition(previous: Metadata<Root>, next: Metadata<Root>) {
  if (
    next.signed.version !== previous.signed.version + 1 ||
    !next.signed.consistentSnapshot ||
    next.signed.isExpired()
  )
    throw new Error("Invalid root rotation version or expiry");
  verifyRole(previous, "root", next);
  verifyRole(next, "root", next);
}
async function signingRoot(directory: string, previous: Metadata<Root>) {
  let bytes: Buffer;
  try {
    bytes = await readSafe(directory, "signing/root.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return previous;
    throw error;
  }
  const root = Metadata.fromJSON(
    MetadataKind.Root,
    JSON.parse(bytes.toString()),
  );
  verifyRootTransition(previous, root);
  return root;
}
async function validatePublisherTransition(
  baseDirectory: string,
  base: Repository,
  directory: string,
  targets: Metadata<Targets>,
) {
  const mutable = new Set([
    "stable/release.json",
    "preview/release.json",
    "revocations.json",
  ]);
  for (const [name, previous] of Object.entries(base.targets.signed.targets)) {
    const next = targets.signed.targets[name];
    if (!mutable.has(name) && next && !previous.equals(next))
      throw new Error("An immutable release target was changed");
    if (name.startsWith("releases/") && !next)
      throw new Error("Immutable release records cannot be removed");
  }
  const records = new Map<string, ReleaseSet>();
  const versions = new Set<number>();
  let oldMaximum = 0;
  for (const [name, target] of Object.entries(base.targets.signed.targets)) {
    if (name.startsWith("releases/") && name.endsWith(".json")) {
      const record = JSON.parse(
        (await targetBytes(baseDirectory, target)).toString(),
      );
      oldMaximum = Math.max(oldMaximum, record.version);
    }
  }
  for (const [name, target] of Object.entries(targets.signed.targets)) {
    if (!name.startsWith("releases/")) continue;
    const record = JSON.parse(
      (await targetBytes(directory, target)).toString(),
    ) as ReleaseSet;
    validateReleaseManifest(record);
    if (name !== `releases/${record.id}.json` || versions.has(record.version))
      throw new Error("Invalid or duplicate release record");
    if (!base.targets.signed.targets[name] && record.version <= oldMaximum)
      throw new Error("New release version rolls backward");
    versions.add(record.version);
    records.set(record.id, record);
  }
  const policy = async (source: string, metadata: Metadata<Targets>) => {
    const target = metadata.signed.targets["revocations.json"];
    const value = target
      ? JSON.parse((await targetBytes(source, target)).toString())
      : { version: 0, releases: [] };
    if (
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      !Array.isArray(value.releases) ||
      value.releases.length > 2000 ||
      value.releases.some(
        (id: unknown) => typeof id !== "string" || !/^[\w.-]{1,100}$/.test(id),
      )
    )
      throw new Error("Invalid revocation policy");
    return value as { version: number; releases: string[] };
  };
  const oldPolicy = await policy(baseDirectory, base.targets),
    newPolicy = await policy(directory, targets);
  if (
    newPolicy.version < oldPolicy.version ||
    oldPolicy.releases.some((id) => !newPolicy.releases.includes(id)) ||
    (!isDeepStrictEqual(oldPolicy, newPolicy) &&
      newPolicy.version <= oldPolicy.version)
  )
    throw new Error("Revocations must advance monotonically");
  if (newPolicy.releases.some((id) => !records.has(id)))
    throw new Error("Unknown release revocation");
  for (const channel of ["stable", "preview"] as const) {
    const target = targets.signed.targets[channel + "/release.json"];
    if (!target) continue;
    const manifest = JSON.parse(
      (await targetBytes(directory, target)).toString(),
    ) as ReleaseSet;
    validateReleaseManifest(manifest);
    const record = records.get(manifest.id);
    if (
      !record ||
      manifest.channel !== channel ||
      !isDeepStrictEqual({ ...record, channel }, manifest) ||
      newPolicy.releases.includes(manifest.id)
    )
      throw new Error(
        "Channel does not reference an authorized immutable release",
      );
    const previous = base.targets.signed.targets[channel + "/release.json"];
    if (
      previous &&
      JSON.parse((await targetBytes(baseDirectory, previous)).toString())
        .version > manifest.version
    )
      throw new Error("Channel rollback is forbidden");
    for (const [name, file] of Object.entries(manifest.files)) {
      const actual = targets.signed.targets[manifest.id + "/" + name];
      if (
        !actual ||
        actual.length !== file.size ||
        actual.hashes.sha256 !== file.sha256
      )
        throw new Error("Channel artifact digest mismatch");
    }
  }
  const allowed = new Set([
    ...mutable,
    ...[...records].map(([id]) => `releases/${id}.json`),
  ]);
  for (const record of records.values())
    if (!newPolicy.releases.includes(record.id))
      for (const name of Object.keys(record.files))
        allowed.add(record.id + "/" + name);
  if (Object.keys(targets.signed.targets).some((name) => !allowed.has(name)))
    throw new Error("Undeclared or revoked target in publisher request");
  if (new Date(targets.signed.expires).getTime() > Date.now() + 31 * 86400000)
    throw new Error("Targets authorization lasts longer than policy permits");
}
export async function signPublisherTargets(
  directory: string,
  pinned: Metadata<Root>,
  signer: RoleSigner,
) {
  const base = await readPublisherRepository(directory, pinned);
  const targets = Metadata.fromJSON(
    MetadataKind.Targets,
    JSON.parse((await readSafe(directory, "signing/targets.json")).toString()),
  );
  if (
    targets.signed.version !==
      (base.timestamp ? base.targets.signed.version + 1 : 1) ||
    targets.signed.isExpired()
  )
    throw new Error("Invalid signing request version/expiry");
  for (const target of Object.values(targets.signed.targets))
    await targetBytes(directory, target);
  await validatePublisherTransition(directory, base, directory, targets);
  signRole(await signingRoot(directory, base.root), "targets", targets, signer);
  await writeFile(join(directory, "signing/targets.json"), encode(targets));
}
export async function finalizePublisher(
  directory: string,
  output: string,
  pinned: Metadata<Root>,
  online: { snapshot: RoleSigner; timestamp: RoleSigner },
  renewal = false,
  currentDirectory?: string,
) {
  if (!renewal && !currentDirectory)
    throw new Error(
      "Publication requires the current repository as a separate baseline",
    );
  const base = await readPublisherRepository(directory, pinned);
  const currentPath = currentDirectory ?? directory;
  const current = await readPublisherRepository(currentPath, pinned);
  if (
    !encode(current.root).equals(encode(base.root)) ||
    !encode(current.targets).equals(encode(base.targets)) ||
    current.timestamp?.signed.version !== base.timestamp?.signed.version
  )
    throw new Error(
      "Signing request is stale relative to the published repository",
    );
  const targets = renewal
    ? base.targets
    : Metadata.fromJSON(
        MetadataKind.Targets,
        JSON.parse(
          (await readSafe(directory, "signing/targets.json")).toString(),
        ),
      );
  const root = await signingRoot(directory, base.root);
  verifyRole(root, "targets", targets);
  if (root.signed.isExpired() || targets.signed.isExpired())
    throw new Error("Offline authorization expired");
  if (
    !renewal &&
    targets.signed.version !==
      (base.timestamp ? base.targets.signed.version + 1 : 1)
  )
    throw new Error("Replayed signing event");
  for (const target of Object.values(targets.signed.targets))
    await targetBytes(directory, target);
  await validatePublisherTransition(currentPath, current, directory, targets);
  const fileInfo = (metadata: Metadata<any>) =>
    new MetaFile({
      version: metadata.signed.version,
      length: encode(metadata).length,
      hashes: { sha256: sha256(encode(metadata)) },
    });
  const snapshot = new Metadata(
    new Snapshot({
      ...common((base.snapshot?.signed.version ?? 0) + 1, 7),
      meta: { "targets.json": fileInfo(targets) },
    }),
  );
  signRole(root, "snapshot", snapshot, online.snapshot);
  const timestamp = new Metadata(
    new Timestamp({
      ...common((base.timestamp?.signed.version ?? 0) + 1, 1),
      snapshotMeta: fileInfo(snapshot),
    }),
  );
  signRole(root, "timestamp", timestamp, online.timestamp);
  await mkdir(output);
  await copyPublic(directory, output);
  await immutable(
    output,
    `metadata/${root.signed.version}.root.json`,
    encode(root),
  );
  await writeFile(join(output, "metadata/root.json"), encode(root));
  await immutable(
    output,
    `metadata/${targets.signed.version}.targets.json`,
    encode(targets),
  );
  await immutable(
    output,
    `metadata/${snapshot.signed.version}.snapshot.json`,
    encode(snapshot),
  );
  await writeFile(join(output, "metadata/timestamp.json"), encode(timestamp));
  // Candidate files that were revoked stay immutable but are no longer authorized targets.
  await readPublisherRepository(output, pinned);
  return {
    root: root.signed.version,
    targets: targets.signed.version,
    snapshot: snapshot.signed.version,
    timestamp: timestamp.signed.version,
  };
}
