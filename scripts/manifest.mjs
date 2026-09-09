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
  shellApi: { min: 1, max: 1 },
  protocol: 1,
  schema: { min: 1, max: 1 },
  ui: "index.html",
  service: "service.cjs",
  extension: "extension.cjs",
  builtins: [
    { id: "builtin.subscription", version: "1.0.0" },
    {
      id: "builtin.network",
      version: "1.0.0",
      capabilities: [],
      contributions: [],
    },
    {
      id: "builtin.rules",
      version: "1.0.0",
      capabilities: [],
      contributions: [],
    },
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
