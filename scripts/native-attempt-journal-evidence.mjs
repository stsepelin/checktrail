import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
export async function nativeJournalRequirements(root) {
  const requirements = [];
  for (const [file, total] of [
    ["native-attempt-frames.test.js", 5],
    ["native-attempt-storage.test.js", 4],
    ["native-invoke.test.js", 14],
  ]) {
    const target = path.join(root, "dist/test", file);
    const text = await readFile(target, "utf8");
    const names = [...text.matchAll(/\btest\(\s*"([^"\n]+)"/g)].map(
      (m) => m[1],
    );
    assert.equal(names.length, total, file);
    assert.equal(new Set(names).size, total, file);
    for (const name of names) {
      if (
        process.platform === "win32" &&
        name ===
          "native invocation closes ordinary descendants retaining output pipes after root exit without inventing a successful timeout"
      )
        continue;
      requirements.push({ file: target, name });
    }
  }
  assert.equal(requirements.length, process.platform === "win32" ? 22 : 23);
  return requirements;
}
