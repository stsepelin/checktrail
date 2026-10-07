import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
assert.ok(
  ["darwin", "linux"].includes(process.platform),
  "Sealed multi-claim guard controls require macOS or Linux",
);
const repository = fileURLToPath(new URL("../", import.meta.url));
const file = path.join(repository, "dist/test/review-benchmark-multi.test.js");
const originalCallback = await readFile(file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scoring =
  "benchmark sealed multi-claim scoring retains duplicates common material denominators paired repetitions and sealed reviewer probabilities";
const mapping =
  "benchmark matching rejects wrong addresses digests quotes families hosts IDs and missing or duplicate claims while retaining every raw response";
const sessions =
  "benchmark matching rejects curator reviewer judge and malformed sibling session reuse without claiming host isolation";
const sealing =
  "benchmark multi-claim scoring preserves missing incomplete unresolved invalid and late mapping slots and rejects changed sealed artifacts";
const guards = [
  {
    id: "sealed-matching-book-bytes",
    name: sealing,
    source: "review-benchmark.js",
    replacements: [
      ["archive.matchingDigest !== inputs.matchingDigest ||", "false ||"],
    ],
  },
  {
    id: "independent-judgment-precedence",
    name: "benchmark common positive matches never override independent wrong mechanism address remedy scope refutation or unresolved verdicts",
    source: "review-benchmark.js",
    replacements: [
      [
        'if (disposition !== "supported")',
        'if (false && disposition !== "supported")',
      ],
    ],
  },
  {
    id: "common-material-denominator",
    name: scoring,
    source: "review-benchmark.js",
    replacements: [
      [
        "({ id, family, material }) => ({ id, family, material })",
        "({ id, family, material }) => ({ id, family, material:false })",
      ],
    ],
  },
  {
    id: "common-defect-family",
    name: mapping,
    source: "review-benchmark.js",
    replacements: [
      [
        "d.id === mapped.defectId && d.family === candidate.family",
        "d.id === mapped.defectId",
      ],
    ],
  },
  {
    id: "sealed-reviewer-probability",
    name: scoring,
    source: "review-benchmark.js",
    replacements: [
      [
        "probability: rawCandidates[i].confidence?.probability ?? null",
        "probability: null",
      ],
    ],
  },
  {
    id: "independent-matching-session",
    name: sessions,
    source: "review-benchmark.js",
    replacements: [
      [
        "if (forbidden.has(id) || indices.size > 1)\n                for (const i of indices)",
        "if (false)\n                for (const i of indices)",
      ],
    ],
  },
  {
    id: "reached-mapping-bytes",
    name: sealing,
    source: "review-benchmark.js",
    replacements: [
      ["!equal(archive.mappings,", "false && !equal(archive.mappings,"],
    ],
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
// A selected callback can exercise many paired trials and invalid mappings.
// Bound the complete callback without changing its nested execution budgets.
const callbackTimeoutMs = 120000;
const started = performance.now();
function phaseProgress(guard, phase, status) {
  process.stderr.write(
    JSON.stringify({
      guard,
      phase,
      status,
      elapsedMs: Math.round(performance.now() - started),
    }) + "\n",
  );
}
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, file],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: callbackTimeoutMs,
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
for (const guard of guards) {
  const source = path.join(repository, "dist/src", guard.source),
    original = await readFile(source, "utf8");
  phaseProgress(guard.id, "original", "started");
  const baseline = run(guard.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  requireTerminal(baseline, guard.name, false);
  phaseProgress(guard.id, "original", "completed");
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
    phaseProgress(guard.id, "mutant", "started");
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
    requireTerminal(result, guard.name, true);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
    );
    assert.deepEqual(
      await readFile(file),
      originalCallback,
      "Guard callback changed",
    );
    phaseProgress(guard.id, "mutant", "completed");
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
  phaseProgress(guard.id, "restored", "started");
  const restored = run(guard.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  requireTerminal(restored, guard.name, false);
  phaseProgress(guard.id, "restored", "completed");
}
process.stdout.write(
  JSON.stringify({
    profile: "sealed-multi-claim-guards-v1",
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
