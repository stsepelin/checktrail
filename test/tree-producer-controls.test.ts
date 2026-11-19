import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const folder = path.join(repository, ".github/treesitter027-producer");
const modules = [
  "test-common-lifecycle-regression.py",
  "test-common-lifecycle.py",
  "test-encrypted-capture.py",
  "test-lifecycle-regression.py",
  "test-lifecycle.py",
  "test-materializer.py",
  "test-native-controller.py",
];

test("Tree-sitter producer carrier binds every selected first-party control", () => {
  const manifest = readFileSync(path.join(folder, "COHORT.json"));
  const rows: { file: string; bytes: number; sha256: string }[] = JSON.parse(
    manifest.toString("utf8"),
  );
  assert.equal(new Set(rows.map((row) => row.file)).size, rows.length);
  assert.deepEqual(
    rows
      .filter((row) => row.file.startsWith("test-"))
      .map((row) => row.file)
      .sort(),
    modules,
  );
  assert.deepEqual(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) =>
        path
          .relative(folder, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/"),
      )
      .sort(),
    [...rows.map((row) => row.file), "COHORT.json"].sort(),
  );
  for (const row of rows) {
    assert.match(
      row.file,
      /^(?:(?:reused-native-v5|reused-sdk-crypto)\/)?[a-z][a-z0-9_.-]+\.(?:py|mjs|json)$/,
    );
    const bytes = readFileSync(path.join(folder, row.file));
    assert.equal(bytes.length, row.bytes, row.file);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      row.sha256,
      row.file,
    );
  }
  const workflow = readFileSync(
    path.join(repository, ".github/workflows/native-tree027-producer.yml"),
    "utf8",
  );
  const digest = createHash("sha256").update(manifest).digest("hex");
  assert.equal(workflow.split(digest).length - 1, 3);
  for (const module of modules) {
    assert.ok(workflow.includes(`"$root/${module}"`), module);
  }
});

test(
  "Tree-sitter selected macOS producer controls preserve failures and the read-only carrier",
  {
    skip:
      process.platform !== "darwin"
        ? "Selected native producer is macOS-only"
        : false,
  },
  () => {
    for (const module of modules) {
      const result = spawnSync(
        "python3",
        ["-I", "-S", "-B", path.join(folder, module)],
        {
          cwd: repository,
          encoding: "utf8",
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const output = result.stdout + result.stderr;
      assert.equal(
        result.error,
        undefined,
        `${module}: ${String(result.error)}`,
      );
      assert.equal(result.signal, null, `${module}: ${output}`);
      assert.equal(result.status, 0, `${module}: ${output}`);
      const count = output.match(/\nRan ([1-9][0-9]*) tests? in /);
      assert.ok(count, `${module}: no executed tests\n${output}`);
      assert.match(
        output,
        /\nOK\s*$/,
        `${module}: failures or skips\n${output}`,
      );
    }
  },
);
