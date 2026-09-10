import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const [id, versionText, channel = "stable"] = process.argv.slice(2);
const version = Number(versionText);
if (
  !/^[\w.-]{1,100}$/.test(id ?? "") ||
  !Number.isSafeInteger(version) ||
  version < 1 ||
  !["stable", "preview"].includes(channel)
)
  throw new Error(
    "Usage: node scripts/manifest.mjs <release-id> <monotonic-version> [stable|preview]",
  );
const files = {};
async function walk(dir, relative = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = relative + entry.name;
    if (entry.isDirectory()) await walk(join(dir, entry.name), name + "/");
    else if (entry.isFile()) {
      const bytes = await readFile(join(dir, entry.name));
      files[name] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    } else throw new Error("Unsupported file");
  }
}
await walk("dist/release");
const packageVersion = JSON.parse(
  await readFile("package.json", "utf8"),
).version;
const compatibility = JSON.parse(
  await readFile("packages/contracts/src/compatibility.json", "utf8"),
);
const manifest = {
  id,
  version,
  channel,
  publisher: "flowgate",
  platforms: [process.platform + "-" + process.arch],
  components: {
    ui: packageVersion,
    service: packageVersion,
    extension: packageVersion,
  },
  releaseNotes: process.env.FLOWGATE_RELEASE_NOTES ?? "",
  shellApi: { min: compatibility.shellApi, max: compatibility.shellApi },
  protocol: 1,
  schema: { min: compatibility.schema, max: compatibility.schema },
  ui: "index.html",
  service: "service.cjs",
  extension: "extension.cjs",
  catalogVersion: 1,
  builtins: [
    ...[
      ...JSON.parse(
        await readFile("packages/contracts/src/builtin-catalog.json", "utf8"),
      ),
      ...JSON.parse(
        await readFile("packages/contracts/src/service-catalog.json", "utf8"),
      ),
    ].map(({ id, version, capabilities, permissions, contributions }) => ({
      id,
      version,
      capabilities,
      permissions,
      contributions,
    })),
    {
      id: "internal.gateway-test",
      version: "1.0.0",
      capabilities: [
        "services",
        "endpoints",
        "streams",
        "egress",
        "credentials",
        "storage",
        "jobs",
        "uiContributions",
        "observability",
        "releaseLifecycle",
      ],
      contributions: ["settings"],
    },
  ],
  files,
};
await mkdir("work/releases", { recursive: true });
const path = join("work/releases", id + ".json");
await writeFile(path, JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(path);
