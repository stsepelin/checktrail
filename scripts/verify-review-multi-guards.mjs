import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const source = new URL("../dist/src/review-multi-scoring.js", import.meta.url),
  callback = new URL(
    "../dist/test/review-multi-scoring.test.js",
    import.meta.url,
  );
const original = await readFile(source, "utf8"),
  originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const guards = [
  {
    id: "unique-common-defect",
    name: "multi-claim scoring counts every disposition deduplicates common defects and preserves hand-computed precision recall and probabilities",
    before: "numerator: matches.size,",
    after: "numerator: claims.filter((c) => supported(row, c)).length,",
  },
  {
    id: "missing-material-denominator",
    name: "multi-claim scoring retains missing incomplete cancelled and unknown label slots without scoring prefixes or favorable declarations",
    before: "denominator: material.length,",
    after: "denominator: completed ? material.length : 0,",
  },
  {
    id: "whole-incident-cluster",
    name: "multi-claim scoring resamples whole unequal incident clusters together and refuses undefined or degenerate intervals",
    before: "groups.get(row.clusterId)",
    after: "groups.get(row.id)",
    second: ["groups.set(row.clusterId, group)", "groups.set(row.id, group)"],
  },
  {
    id: "known-common-defect-family",
    name: "multi-claim scoring rejects foreign duplicate contradictory family and unmapped identities while accepting exact bounded near misses",
    before: "d.id === c.defectId && d.family === c.family",
    after: "d.id === c.defectId",
  },
];
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
function run(name) {
  const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      pattern,
      fileURLToPath(callback),
    ],
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
  const baseline = run(guard.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  let mutant = original;
  for (const [before, after] of [
    [guard.before, guard.after],
    ...(guard.second ? [guard.second] : []),
  ]) {
    assert.equal(
      mutant.split(before).length,
      2,
      "Exact mutation address: " + guard.id,
    );
    mutant = mutant.replace(before, after);
  }
  try {
    await writeFile(source, mutant);
    const compile = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(source)],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = run(guard.name);
    assert.equal(
      result.status,
      1,
      "Original assertion must kill " +
        guard.id +
        "\n" +
        result.stdout +
        result.stderr,
    );
    assert.match(result.stdout, /ERR_ASSERTION/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(result.stdout.includes("not ok 1 - " + guard.name));
    assert.deepEqual(
      await readFile(callback),
      originalCallback,
      "Original callback changed",
    );
    evidence.push({
      id: guard.id,
      callback: guard.name,
      callbackSha256: digest(originalCallback),
      sourceSha256: digest(original),
      mutantSha256: digest(mutant),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(source, original);
  }
  const restored = run(guard.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  evidence.at(-1).restoredPassed = true;
}
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic multi-claim numerical assertions; no inference or field evaluation",
    guards: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
