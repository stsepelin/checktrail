import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "kotlin guard controls require the pinned native Kotlin toolchain",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/kotlin.test.js");
const originalCallback = await readFile(file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const guards = [
  {
    id: "original-native-plugin",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [["native.registrations !== 1 ||", "false ||"]],
  },
  {
    id: "physical-source-identity",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [["kotlinHash(physical) !== before.sha256 ||", "false ||"]],
  },
  {
    id: "native-source-identity",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [
      ["kotlinHash(nativeBytes) !== before.nativeSha256", "false"],
    ],
  },
  {
    id: "resolved-suppression-accounting",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [
      [
        'observed.annotations.some((a) => a === "kotlin.Suppress" || a === "java.lang.SuppressWarnings")',
        "false",
      ],
    ],
  },
  {
    id: "native-node-accounting",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [["nodes !== native.firNodes", "false"]],
  },
  {
    id: "native-ir-completion",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [["native.irModules !== 1 ||", "false ||"]],
  },
  {
    id: "physical-class-output",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [["physical.sha256 !== item.sha256 ||", "false ||"]],
  },
  {
    id: "declared-class-target",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [
      [
        'item.classMajor !==\n                (name.endsWith(".class") ? Number(planned.config.jvmTarget) + 44 : null)',
        "false",
      ],
    ],
  },
  {
    id: "physical-raw-integrity",
    name: "native Kotlin rejects coherent stale source missing frontend IR output diagnostics and raw evidence",
    source: "kotlin-evidence.js",
    replacements: [
      ["parseCapturedProcessOutput(data.nativeOutput)", "data.nativeOutput"],
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
      timeout: 120000,
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
      mutantOutputSha256: digest(result.stdout),
      mutantStderrSha256: digest(result.stderr),
    });
  } finally {
    await writeFile(source, original);
  }
  const restored = run(guard.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
}
process.stdout.write(
  JSON.stringify({
    profile: "kotlin-compiler-guards-v1",
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
