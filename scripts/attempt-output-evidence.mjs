import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function attemptOutputCodeIdentity(root) {
  const parts = [];
  async function walk(relative) {
    const entries = await readdir(path.join(root, "dist/src", relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        assert.equal(
          entry.isFile(),
          true,
          "Compiled code identity cannot follow file links",
        );
        parts.push([
          file.split(path.sep).join("/"),
          hash(await readFile(path.join(root, "dist/src", file))),
        ]);
      }
    }
  }
  await walk("");
  assert.ok(parts.length > 0);
  return hash(JSON.stringify(parts));
}
export async function attemptOutputRequirements(root) {
  const requirements = [];
  for (const [file, total] of [
    ["attempt-archive.test.js", 5],
    ["attempt-archive-native.test.js", 1],
    ["process-output.test.js", 4],
  ]) {
    const target = path.join(root, "dist/test", file);
    const text = await readFile(target, "utf8");
    const names = [...text.matchAll(/\btest\(\s*"([^"\n]+)"/g)].map(
      (m) => m[1],
    );
    assert.equal(names.length, total, file);
    assert.equal(new Set(names).size, total, file);
    for (const name of names) requirements.push({ file: target, name });
  }
  assert.equal(requirements.length, 10);
  return requirements;
}
