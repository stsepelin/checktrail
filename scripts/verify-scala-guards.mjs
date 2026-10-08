import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "scala guard controls require the pinned native Scala toolchain",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/scala.test.js");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const guards = [
  {
    id: "original-native-observer",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["native.registrations !== 1 ||", "false ||"]],
  },
  {
    id: "native-finish",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["native.finishCalls !== 1 ||", "false ||"]],
  },
  {
    id: "physical-source-identity",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["scalaHash(physical) !== before.sha256 ||", "false ||"]],
  },
  {
    id: "native-source-identity",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["scalaHash(physical) !== before.nativeSha256", "false"]],
  },
  {
    id: "resolved-suppression-accounting",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [
      [
        "observed.annotations.some((a) => scalaArtifacts.suppressionAnnotations.includes(a))",
        "false",
      ],
    ],
  },
  {
    id: "native-tree-accounting",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["nodes !== native.nodes ||", "false ||"]],
  },
  {
    id: "native-type-accounting",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["types !== native.types", "false"]],
  },
  {
    id: "native-phase-plan",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [
      [
        "JSON.stringify(native.phases) !== JSON.stringify(scalaArtifacts.phases)",
        "false",
      ],
    ],
  },
  {
    id: "native-backend-completion",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["native.completeStages !== 1 ||", "false ||"]],
  },
  {
    id: "physical-class-output",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [["physical.sha256 !== item.sha256 ||", "false ||"]],
  },
  {
    id: "declared-class-target",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [
      [
        'item.classMajor !==\n                (name.endsWith(".class") ? Number(planned.config.jvmTarget) + 44 : null)',
        "false",
      ],
    ],
  },
  {
    id: "physical-raw-integrity",
    name: "native Scala rejects coherent stale source missing typed backend output diagnostics and raw evidence",
    source: "scala-evidence.js",
    replacements: [
      ["parseCapturedProcessOutput(data.nativeOutput)", "data.nativeOutput"],
    ],
  },
  {
    id: "empty-analysis-inventory",
    name: "native Scala empty or comment-only declaration inventories remain incomplete after genuine frontend backend and source callbacks",
    source: "scala-evidence.js",
    file: "scala-boundaries.test.js",
    replacements: [["!native.declarations ||", "false ||"]],
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name, selectedFile = file) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      pattern,
      selectedFile,
    ],
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
function requireTerminal(result, name, failed) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    result.stdout,
    new RegExp(
      "^" + (failed ? "not ok" : "ok") + " [0-9]+ - " + escaped + "$",
      "m",
    ),
    "The exact original callback must run without a skip",
  );
}
const evidence = [];
const positiveControls = new Map();
let positiveControlExecutions = 0;
for (const guard of guards) {
  const selectedFile = guard.file
    ? path.join(repository, "dist/test", guard.file)
    : file;
  const originalCallback = await readFile(selectedFile);
  const source = path.join(repository, "dist/src", guard.source),
    original = await readFile(source, "utf8");
  const positiveIdentity = JSON.stringify([
    selectedFile,
    guard.name,
    source,
    digest(original),
    digest(originalCallback),
  ]);
  if (!positiveControls.has(positiveIdentity)) {
    const baseline = run(guard.name, selectedFile);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    requireTerminal(baseline, guard.name, false);
    positiveControls.set(positiveIdentity, {
      name: guard.name,
      file: selectedFile,
      source,
      original,
      callback: originalCallback,
    });
    positiveControlExecutions++;
  }
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
    const result = run(guard.name, selectedFile);
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
    requireTerminal(result, guard.name, true);
    assert.match(result.stdout, /expected: 'inconclusive'/);
    assert.match(result.stdout, /actual: 'passed'/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
    );
    assert.deepEqual(
      await readFile(selectedFile),
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
  assert.equal(
    await readFile(source, "utf8"),
    original,
    "Mutated source was not restored",
  );
}
for (const positive of positiveControls.values()) {
  assert.equal(
    await readFile(positive.source, "utf8"),
    positive.original,
    "Original source changed before final positive control",
  );
  assert.deepEqual(
    await readFile(positive.file),
    positive.callback,
    "Original callback changed before final positive control",
  );
  const restored = run(positive.name, positive.file);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  requireTerminal(restored, positive.name, false);
  positiveControlExecutions++;
}
process.stdout.write(
  JSON.stringify({
    profile: "scala-compiler-guards-v1",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    guards: evidence,
    positiveControlExecutions,
    positiveControlsReusedOnlyForIdenticalBytes: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
