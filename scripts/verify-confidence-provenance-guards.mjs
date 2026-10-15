import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  source = new URL("../dist/src/review-provenance.js", import.meta.url),
  callback = new URL(
    "../dist/test/gate-confidence-provenance.test.js",
    import.meta.url,
  ),
  original = await readFile(source, "utf8"),
  before = await readFile(callback),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const address = (pattern) => {
  const matches = [...original.matchAll(new RegExp(pattern, "g"))];
  assert.equal(
    matches.length,
    1,
    "One exact compiled mutation address: " + pattern,
  );
  return matches[0][0];
};
const controls = [
  {
    id: "inspection-cancellation",
    name: "lifecycle",
    from: "!options.signal?.aborted",
    to: "true",
  },
  {
    id: "inspection-deadline",
    name: "lifecycle",
    from: "performance.now() < deadline",
    to: "true",
  },
  {
    id: "native-function-address",
    name: "prerequisite",
    from: "fn.end === run.functionRange.end",
    to: "true",
  },
  {
    id: "assessment-claim-binding",
    name: "prerequisite",
    from: address(
      "isDeepStrictEqual\\(observation, \\{[\\s\\S]*?\\n\\s*\\}\\)",
    ),
    to: "true",
  },
  {
    id: "native-candidate-binding",
    name: "broken",
    from: "run.candidateDigest === hash(JSON.stringify(c))",
    to: "true",
  },
  {
    id: "native-context-binding",
    name: "prerequisite",
    from: "run.contextDigest === context.contextDigest",
    to: "true",
  },
  {
    id: "physical-source-address-match",
    name: "empty",
    from: "addressChecks.every((check) => check.matchesContext)",
    to: "true",
  },
  {
    id: "host-probability-score-binding",
    name: "near-miss",
    from: address(
      "row\\.probability ===\\s*\\(c\\.confidence\\?\\.probability \\?\\?\\s*null\\)",
    ),
    to: "true",
  },
  {
    id: "unique-scoring-source-binding",
    name: "prerequisite",
    from: "map.size === bindings.length",
    to: "true",
  },
  {
    id: "every-scoring-source-byte-binding",
    name: "prerequisite",
    from: "context.files.some((f) => f.path === b.file && f.sha256 === b.sourceDigest)",
    to: "true",
  },
  {
    id: "stale-scoring-admission",
    name: "stale",
    from: address(
      'receipt\\.freshness === "current" \\|\\|\\s*observations\\.every\\(\\(row\\) => row\\.status === "stale"\\)',
    ),
    to: "true",
  },
  {
    id: "derived-report-projection-binding",
    name: "empty",
    from: "isDeepStrictEqual(candidateEvidence, e)",
    to: "true",
  },
  {
    id: "operator-source-disclosure",
    name: "privacy",
    from: "if (allowSource)",
    to: "if (true)",
  },
  {
    id: "serialized-input-byte-bound",
    name: "empty",
    from: address("Buffer\\.byteLength\\(text\\) <=\\s*1048576"),
    to: "true",
  },
];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const run = (name) =>
  spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=1",
      "--test-name-pattern=^confidence-provenance " + name + " acceptance$",
      fileURLToPath(callback),
    ],
    {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 1048576,
    },
  );
const complete = (r) => {
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.signal, null, r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# pass 1$/m);
  assert.match(r.stdout, /^# skipped 0$/m);
};
const results = [];
for (const control of controls) {
  const name = "confidence-provenance " + control.name + " acceptance";
  complete(run(control.name));
  assert.equal(original.split(control.from).length, 2, control.id);
  const mutant = original.replace(control.from, control.to);
  try {
    await writeFile(source, mutant);
    const checked = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(source)],
      { encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
    const failed = run(control.name);
    assert.equal(failed.error, undefined, failed.error?.message);
    assert.equal(failed.signal, null, failed.stdout + failed.stderr);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /code: 'ERR_ASSERTION'/);
    assert.match(failed.stdout, /^# fail 1$/m);
    assert.match(failed.stdout, /^# skipped 0$/m);
  } finally {
    await writeFile(source, original);
  }
  complete(run(control.name));
  assert.equal(await readFile(source, "utf8"), original);
  results.push({
    id: control.id,
    callback: name,
    guardExpressionsRemoved: 1,
    originalPassed: true,
    mutantCompiled: true,
    mutantFailedAssertion: true,
    restoredPassed: true,
    originalSha256: hash(original),
    mutantSha256: hash(mutant),
  });
}
assert.deepEqual(await readFile(callback), before);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "confidence-provenance",
    controls: results,
    callbacks: [
      { file: "gate-confidence-provenance.test.js", sha256: hash(before) },
    ],
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeProbesExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
