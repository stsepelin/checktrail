import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export async function fixture(
  t: TestContext,
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "checktrail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

export const nodeManifest = JSON.stringify({
  private: true,
  type: "module",
  scripts: { test: "node --test" },
});
export const passingTest =
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('adds integers', () => assert.equal(2 + 3, 5));";
