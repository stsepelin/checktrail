import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/import-history.test.js");
const callback = await readFile(file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const first =
  "historical imports retain deleted consumers and whole old decisions while fixed and root-boundary near misses remain distinct";
const second =
  "historical imports distinguish stage-zero index working bytes mode-only changes and moved source without guessing renames";
const fallback =
  "historical imports retain full fallback for old missing aliases ambiguous targets symlinks malformed source and exhausted discovery";
const fresh =
  "historical import reconstruction rejects stale base current index modes scope and coherent rehashed edges or impact";
const guards = [
  {
    id: "configured-git-root",
    name: "historical imports reject parent Git enumeration before reading objects outside the configured nested root",
    from: "if (gitRoot !== before.root)",
    to: "if (false && gitRoot !== before.root)",
  },
  {
    id: "historical-file-union",
    name: first,
    from: "new Set([...base, ...current])",
    to: "new Set([...current])",
  },
  {
    id: "historical-edge-union",
    name: first,
    from: "const edges = edgeMap();",
    to: 'const edges = edgeMap("current");',
  },
  {
    id: "revision-edge-binding",
    name: first,
    from: 'base: edgeMap("base")',
    to: 'base: edgeMap("current")',
  },
  {
    id: "selected-file-mode",
    name: second,
    from: "if (mode.before !== mode.after)",
    to: "if (false && mode.before !== mode.after)",
  },
  {
    id: "unknown-import-fallback",
    name: fallback,
    from: 'if (modules.some((m) => m.resolution !== "selected"))',
    to: 'if (false && modules.some((m) => m.resolution !== "selected"))',
  },
  {
    id: "source-reconstruction",
    name: fresh,
    from: "if (JSON.stringify(report) !== JSON.stringify(rebuilt))",
    to: "if (false && JSON.stringify(report) !== JSON.stringify(rebuilt))",
  },
];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, file],
    {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}
function terminal(result, name, passed) {
  const line = result.stdout
    .split("\n")
    .find((line) =>
      new RegExp(
        "^(?:not )?ok \\d+ - " +
          name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?:$| #)",
      ).test(line),
    );
  assert.ok(line, "Exact terminal missing: " + name);
  assert.doesNotMatch(line, /# (?:SKIP|TODO)/i);
  assert.equal(line.startsWith("ok "), passed);
}
const source = path.join(repository, "dist/src/import-history.js");
const original = await readFile(source, "utf8");
const evidence = [];
try {
  for (const guard of guards) {
    const baseline = run(guard.name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    terminal(baseline, guard.name, true);
    assert.equal(
      original.split(guard.from).length,
      2,
      "Exact mutation address: " + guard.id,
    );
    const mutant = original.replace(guard.from, guard.to);
    try {
      await writeFile(source, mutant);
      const compiled = spawnSync(process.execPath, ["--check", source], {
        encoding: "utf8",
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const failed = run(guard.name);
      assert.equal(
        failed.status,
        1,
        "Original callback must kill " +
          guard.id +
          "\n" +
          failed.stdout +
          failed.stderr,
      );
      terminal(failed, guard.name, false);
      assert.match(failed.stdout, /ERR_ASSERTION/);
      assert.doesNotMatch(
        failed.stdout + failed.stderr,
        /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
      );
      assert.deepEqual(
        await readFile(file),
        callback,
        "Original callback changed",
      );
      evidence.push({
        id: guard.id,
        callback: guard.name,
        callbackSha256: digest(callback),
        sourceSha256: digest(original),
        mutantSha256: digest(mutant),
        originalPassed: true,
        mutantKilled: true,
        mutantOutputSha256: digest(failed.stdout),
        mutantStderrSha256: digest(failed.stderr),
      });
    } finally {
      await writeFile(source, original);
    }
    const restored = run(guard.name);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    terminal(restored, guard.name, true);
  }
} finally {
  await writeFile(source, original);
}
process.stdout.write(
  JSON.stringify({
    profile: "import-history-guards-v1",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    guards: evidence,
    sourceRestored: (await readFile(source, "utf8")) === original,
    callbacksUnchanged: digest(await readFile(file)) === digest(callback),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
