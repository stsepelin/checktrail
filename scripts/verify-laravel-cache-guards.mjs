import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "POSIX guard controls require macOS or Linux",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/laravel-cache.test.js");
const originalCallback = await readFile(file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const forced =
  "native Laravel forced PHP termination after boot removes cache files and the shared owned parent";
const normal =
  "native Laravel normal and reached bootstrap error paths preserve project caches and clean owned cache parents";
const guards = [
  {
    id: "shared-owned-parent-cleanup",
    name: forced,
    source: "runner.js",
    replacements: [
      [
        "if (temporary)\n            await rm(temporary, { recursive: true, force: true });",
        "if (false && temporary)\n            await rm(temporary, { recursive: true, force: true });",
      ],
    ],
  },
  {
    id: "php-owned-cache-location",
    name: forced,
    source: "laravel-runner.js",
    replacements: [
      [
        "$rv_temporary = $rv_owned.'/laravel-cache';",
        "$rv_temporary = sys_get_temp_dir().'/original-outside-'.bin2hex(random_bytes(8));",
      ],
    ],
  },
  {
    id: "protected-dotenv-loader",
    name: normal,
    source: "laravel-runner.js",
    replacements: [
      [
        "$app->useEnvironmentPath($rv_temporary)->loadEnvironmentFrom('.env');",
        "$app->useEnvironmentPath($rv_root)->loadEnvironmentFrom('.env');",
      ],
    ],
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, file],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}
const evidence = [];
for (const guard of guards) {
  const source = path.join(repository, "dist/src", guard.source),
    original = await readFile(source, "utf8");
  const baseline = run(guard.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  let mutant = original;
  for (const [before, after] of guard.replacements) {
    assert.equal(
      mutant.split(before).length,
      2,
      "Exact mutation address: " + guard.id,
    );
    mutant = mutant.replace(before, after);
  }
  try {
    await writeFile(source, mutant);
    const compiled = spawnSync(process.execPath, ["--check", source], {
      encoding: "utf8",
    });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = run(guard.name);
    assert.equal(
      result.status,
      1,
      "Original callback must kill " +
        guard.id +
        "\n" +
        result.stdout +
        result.stderr,
    );
    assert.match(result.stdout, /ERR_ASSERTION/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
    );
    assert.deepEqual(
      await readFile(file),
      originalCallback,
      "Guard callback changed",
    );
    evidence.push({
      id: guard.id,
      callback: guard.name,
      callbackSha256: digest(originalCallback),
      sourceSha256: digest(original),
      mutantSha256: digest(mutant),
      originalPassed: true,
      mutantKilled: true,
      mutantOutput: result.stdout,
      mutantStderr: result.stderr,
    });
  } finally {
    await writeFile(source, original);
  }
  const restored = run(guard.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
}
process.stdout.write(
  JSON.stringify({
    profile: "laravel-owned-cache-guards-v1",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    guards: evidence,
    sourceRestored: true,
    callbacksUnchanged: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
