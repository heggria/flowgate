import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile, realpath, access } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { Metadata, MetadataKind } from "@tufjs/models";
import {
  createPublisherRoot,
  loadRoleSigner,
  preparePublisher,
  signPublisherTargets,
  finalizePublisher,
  readPublisherRepository,
} from "../packages/release/src/publisher.ts";

const roles = ["root", "targets", "snapshot", "timestamp"];
const [command, repository, keyDirectory, output, ...args] =
  process.argv.slice(2);
const commands = [
  "init",
  "publish",
  "refresh",
  "renew-targets",
  "promote",
  "revoke",
  "rotate",
];
if (
  !commands.includes(command) ||
  !repository ||
  !keyDirectory ||
  (command !== "init" && !output)
)
  throw new Error(
    "Usage: node --import tsx scripts/tuf-cli.mjs init <repository> <keys> | publish <repository> <keys> <new-output> <artifacts> <manifest> | refresh <repository> <online-keys> <new-output> <trusted-root> | renew-targets|promote|revoke|rotate <repository> <keys> <new-output> [release-id...|new-keys]",
  );

async function load(keys, selected = roles) {
  return Object.fromEntries(
    await Promise.all(
      selected.map(async (role) => [
        role,
        await loadRoleSigner(join(keys, role + ".pem"), process.cwd()),
      ]),
    ),
  );
}
async function generate(keys) {
  const parent = await realpath(dirname(resolve(keys)));
  const actual = join(parent, resolve(keys).split(sep).at(-1));
  for (const boundary of [await realpath(process.cwd()), resolve(repository)])
    if (actual === boundary || actual.startsWith(boundary + sep))
      throw new Error(
        "Signing keys must stay outside the checkout and public repository",
      );
  await mkdir(actual, { mode: 0o700 });
  for (const role of roles) {
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(
      join(actual, role + ".pem"),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
  }
  return load(actual);
}
const publicKeys = (signers) =>
  Object.fromEntries(roles.map((role) => [role, signers[role].key]));
if (command === "init") {
  try {
    await access(repository);
    throw new Error("Bootstrap repository must not exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const signers = await generate(keyDirectory);
  const root = createPublisherRoot(publicKeys(signers), signers.root);
  const bytes = JSON.stringify(root.toJSON());
  await mkdir(join(repository, "metadata"), { recursive: true });
  for (const name of ["root.json", "1.root.json"])
    await writeFile(join(repository, "metadata", name), bytes, { flag: "wx" });
  await writeFile(join(keyDirectory, "trusted-root.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Created public trust root and four separate local signing keys");
} else {
  const anchor =
    command === "refresh" ? args[0] : join(keyDirectory, "trusted-root.json");
  if (!anchor)
    throw new Error("Refresh requires an independently trusted root");
  const pinned = Metadata.fromJSON(
    MetadataKind.Root,
    JSON.parse(await readFile(anchor, "utf8")),
  );
  if (command === "refresh") {
    const current = await readPublisherRepository(repository, pinned);
    for (const [role, metadata, warningDays] of [
      ["root", current.root, 30],
      ["targets", current.targets, 7],
    ]) {
      const days = Math.floor(
        (Date.parse(metadata.signed.expires) - Date.now()) / 86400000,
      );
      if (days < warningDays)
        console.warn(
          `${process.env.GITHUB_ACTIONS ? "::warning::" : "WARNING: "}${role} authorization expires in ${days} days; local signer renewal is required`,
        );
    }
    console.log(
      JSON.stringify(
        await finalizePublisher(
          repository,
          output,
          pinned,
          await load(keyDirectory, ["snapshot", "timestamp"]),
          true,
        ),
      ),
    );
  } else {
    let signers = await load(keyDirectory),
      rootUpdate;
    let change;
    if (command === "publish") {
      const [artifacts, manifest] = args;
      if (!artifacts || !manifest)
        throw new Error("Publish requires artifacts and manifest");
      change = {
        kind: "release",
        artifacts,
        manifest: JSON.parse(await readFile(manifest, "utf8")),
      };
    } else if (command === "promote") {
      if (args.length !== 1) throw new Error("Promote requires one release ID");
      change = { kind: "promote", id: args[0] };
    } else if (command === "revoke") change = { kind: "revoke", ids: args };
    else {
      change = { kind: "refresh-targets" };
      if (command === "rotate") {
        if (args.length !== 1)
          throw new Error("Rotate requires a new non-existing key directory");
        const old = await readPublisherRepository(repository, pinned);
        const replacement = await generate(args[0]);
        rootUpdate = createPublisherRoot(
          publicKeys(replacement),
          replacement.root,
          { root: old.root, signer: signers.root },
        );
        await writeFile(
          join(args[0], "trusted-root.json"),
          JSON.stringify(pinned.toJSON()),
          { mode: 0o600, flag: "wx" },
        );
        signers = replacement;
      }
    }
    const request = output + ".request";
    await preparePublisher(repository, request, pinned, change, rootUpdate);
    await signPublisherTargets(request, pinned, signers.targets);
    console.log(
      JSON.stringify(
        await finalizePublisher(
          request,
          output,
          pinned,
          signers,
          false,
          repository,
        ),
      ),
    );
  }
}
