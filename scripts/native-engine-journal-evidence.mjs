import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { nativeJournalRequirements } from "./native-attempt-journal-evidence.mjs";
export async function nativeEngineJournalRequirements(root) {
  const original = await nativeJournalRequirements(root);
  const file = path.join(root, "dist/test/native-journal-engine.test.js");
  const text = await readFile(file, "utf8");
  const names = [...text.matchAll(/\btest\(\s*"([^"\n]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, 12);
  const requirements = [...original, ...names.map((name) => ({ file, name }))];
  assert.equal(requirements.length, process.platform === "win32" ? 34 : 35);
  return requirements;
}
