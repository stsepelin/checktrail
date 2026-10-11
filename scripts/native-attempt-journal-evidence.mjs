import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function nativeJournalRequirements(root) {
  const requirements = [];
  for (const [file, total] of [
    ["native-attempt-frames.test.js", 5],
    ["native-attempt-storage.test.js", 4],
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
  assert.equal(requirements.length, 9);
  return requirements;
}
