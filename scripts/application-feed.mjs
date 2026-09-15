import assert from "node:assert/strict";

// Squirrel.Mac static JSON format (Electron serverType: "json"):
// https://github.com/Squirrel/Squirrel.Mac#update-file-json-format
export function compareApplicationVersions(a, b) {
  const parse = (value) => {
    assert.equal(
      typeof value,
      "string",
      "Application version must be a string",
    );
    assert.match(
      value,
      /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/,
      "Use a numeric major.minor.patch application version",
    );
    return value.split(".").map(Number);
  };
  const left = parse(a),
    right = parse(b);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index])
      return Math.sign(left[index] - right[index]);
  return 0;
}
export function createApplicationFeed({
  version,
  url,
  notes,
  publishedAt,
  sha256,
  size,
}) {
  compareApplicationVersions(version, version);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Error("A permanent HTTPS archive URL is required");
  }
  assert.ok(
    parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash,
    "Archive URL must use HTTPS without credentials or fragments",
  );
  assert.equal(typeof notes, "string");
  assert.ok(
    notes.trim().length > 0 && notes.length <= 20000,
    "Provide bounded release notes",
  );
  assert.match(sha256, /^[a-f0-9]{64}$/, "Archive SHA-256 is required");
  assert.ok(
    Number.isSafeInteger(size) && size > 0,
    "Archive byte size is required",
  );
  const date = new Date(publishedAt);
  assert.ok(
    Number.isFinite(date.getTime()),
    "A valid publication date is required",
  );
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          url: parsed.href,
          name: `FlowGate ${version}`,
          notes: notes.trim(),
          pub_date: date.toISOString(),
          sha256,
          size,
        },
      },
    ],
  };
}
