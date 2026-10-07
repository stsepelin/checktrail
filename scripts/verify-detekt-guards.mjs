import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "detekt guard controls require the pinned native Kotlin toolchain",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/detekt.test.js");
const originalCallback = await readFile(file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const guards = [
  {
    id: "native-rule-plan",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
    replacements: [
      [
        "JSON.stringify(native.rules) !== JSON.stringify(detektArtifacts.rules)",
        "false",
      ],
    ],
  },
  {
    id: "physical-source-identity",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
    replacements: [["detektHash(bytes) !== before.sha256 ||", "false ||"]],
  },
  {
    id: "native-psi-identity",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
    replacements: [["detektHash(text) !== before.canonicalSha256", "false"]],
  },
  {
    id: "native-suppression-accounting",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
    replacements: [["observed.suppressed.length", "0"]],
  },
  {
    id: "native-lifecycle-completion",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
    replacements: [
      [
        '        if (native.events.length !== 2 * expected.length + 2 ||\n            native.events[0].kind !== "analysis-started" ||\n            native.events[0].file !== null ||\n            native.events.at(-1).kind !== "analysis-finished" ||\n            native.events.at(-1).file !== null)\n            return incomplete;\n        const started = new Set(), finished = new Set();\n        for (const event of native.events.slice(1, -1)) {\n            if (!event.file || !snapshots.has(event.file))\n                return incomplete;\n            if (event.kind === "file-started") {\n                if (started.has(event.file))\n                    return incomplete;\n                started.add(event.file);\n            }\n            else if (event.kind === "file-finished") {\n                if (!started.has(event.file) || finished.has(event.file))\n                    return incomplete;\n                finished.add(event.file);\n            }\n            else\n                return incomplete;\n        }\n        if (started.size !== expected.length || finished.size !== expected.length)\n            return incomplete;\n',
        "        // Negative control: native lifecycle accounting omitted.\n",
      ],
    ],
  },
  {
    id: "physical-output-integrity",
    name: "native detekt rejects missing reordered duplicated stale suppressed skipped rule source lifecycle and raw output evidence",
    source: "detekt-evidence.js",
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
    profile: "detekt-light-guards-v1",
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
