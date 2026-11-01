import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

test(
  "Original Node direct XZ materializer preserves source metadata and refuses generated corrupt unsafe or changing inputs",
  { skip: process.platform === "win32" },
  async () => {
    const result = await exec(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        path.join(root, "test/node-original-direct-source-controls.py"),
        path.join(root, "scripts/producer-qualification"),
      ],
      { cwd: root, timeout: 10000, maxBuffer: 32768 },
    );
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Ran 10 tests/u);
    assert.match(result.stderr, /\nOK\s*$/u);
  },
);
