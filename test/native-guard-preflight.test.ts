import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
const root = path.resolve(import.meta.dirname, "../..");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
for (const family of [
  {
    name: "JVM wrapper",
    script: "verify-jvm-wrappers-guards.mjs",
    count: 21,
    liveId: "live-native-output",
    files: [
      "jvm-extension-evidence.js",
      "maven-evidence.js",
      "gradle-evidence.js",
      "jvm-extensions.js",
      "jvm-invoke.js",
      "maven-runner.js",
      "gradle-runner.js",
    ],
  },
  {
    name: "Rust extension",
    script: "verify-rust-extensions-guards.mjs",
    count: 15,
    liveId: "rust-live-native-output",
    files: [
      "rust-toolchain-native.js",
      "rust-workspace-runner.js",
      "rust-workspace-evidence.js",
      "rust-evidence.js",
    ],
  },
]) {
  test(
    family.name +
      " mutation preflight resolves every compiled target without native execution or writes to the targets",
    async () => {
      const before = new Map(
        await Promise.all(
          family.files.map(
            async (file) =>
              [
                file,
                digest(await readFile(path.join(root, "dist/src", file))),
              ] as const,
          ),
        ),
      );
      const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts", family.script), "--preflight"],
        {
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as {
        nativeExecuted: boolean;
        controls: {
          id: string;
          file: string;
          originalSha256: string;
          mutantSha256: string;
          mutantSyntaxValid: boolean;
        }[];
      };
      assert.equal(report.nativeExecuted, false);
      assert.equal(report.controls.length, family.count);
      assert.equal(
        new Set(report.controls.map((control) => control.id)).size,
        family.count,
      );
      assert.ok(
        report.controls.some((control) => control.id === family.liveId),
      );
      assert.deepEqual(
        new Set(report.controls.map((control) => control.file)),
        new Set(family.files),
      );
      for (const control of report.controls) {
        assert.equal(control.originalSha256, before.get(control.file));
        assert.match(control.mutantSha256, /^[a-f0-9]{64}$/);
        assert.notEqual(control.mutantSha256, control.originalSha256);
        assert.equal(control.mutantSyntaxValid, true);
      }
      for (const [file, sha] of before)
        assert.equal(
          digest(await readFile(path.join(root, "dist/src", file))),
          sha,
          "Preflight changed " + file,
        );
    },
  );
}
