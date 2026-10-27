// Explicit synthetic guard removals. Original assertions and fixtures stay fixed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const callback = "dist/test/gate-resource-release-readiness.test.js";
const originals = await Promise.all(
  [callback, "dist/test/resource-release-fixture.js"].map(async (file) => [
    file,
    await readFile(path.join(root, file)),
  ]),
);
const guards = [
  {
    id: "summary-withholds-native-resource-detail",
    file: "dist/src/output.js",
    kind: "privacy",
    from: "if (detailed)\n        return { ...report };",
    to: "if (true)\n        return { ...report };",
  },
  {
    id: "source-grant-remains-explicit",
    file: "dist/src/review.js",
    kind: "privacy",
    from: "if (sourceEnabled)\n        return parsed;",
    to: "if (true)\n        return parsed;",
  },
  {
    id: "retained-legacy-input-identity",
    file: "scripts/release-readiness-tools.mjs",
    kind: "prerequisite",
    from: "if (expected !== undefined)",
    to: "if (false && expected !== undefined)",
  },
  {
    id: "failed-preparation-publishes-no-partial-selection",
    file: "scripts/release-readiness-tools.mjs",
    kind: "prerequisite",
    from: "    await invokeNpm(",
    to: "    await mkdir(directory,{mode:0o700});\n    await invokeNpm(",
  },
  {
    id: "fresh-library-executes-original-native-bodies",
    file: "scripts/package-upgrade-readiness.mjs",
    kind: "near-miss",
    from: "const report=await api.validate(root,{trusted:true});",
    to: "const report=${JSON.stringify(report)};",
  },
  ...(process.platform === "win32"
    ? []
    : [
        {
          id: "child-cpu-is-interval-not-worker-lifetime",
          file: "scripts/native-resource-workload-worker.mjs",
          kind: "fixed",
          from: "const counters = resourceCounterDelta(before, afterValidation);",
          to: "const counters = resourceCounterDelta(afterValidation, afterValidation);",
        },
        {
          id: "physical-archive-reconstruction",
          file: "scripts/native-resource-workload-worker.mjs",
          kind: "fixed",
          from: "reconstructedSha256 = resourceHash(reconstructed);",
          to: "reconstructedSha256 = resourceHash(Buffer.alloc(0));",
        },
      ]),
];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const invoke = (args) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 4 * 1048576,
  });
const run = (kind) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^resource-release-readiness " + kind + " acceptance$",
    callback,
  ]);
function passed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  receipts = [];
for (const guard of guards) {
  const file = path.join(root, guard.file),
    original = await readFile(file),
    text = original.toString("utf8");
  assert.equal(
    text.split(guard.from).length,
    2,
    guard.id + " mutation anchor differs",
  );
  passed(run(guard.kind));
  const mutant = text.replace(guard.from, guard.to);
  try {
    await writeFile(file, mutant);
    const syntax = invoke(["--check", file]);
    assert.equal(syntax.status, 0, syntax.stderr);
    const failed = run(guard.kind);
    assert.equal(failed.error, undefined);
    assert.equal(failed.signal, null);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /ERR_ASSERTION/);
    assert.match(failed.stdout, /^# fail 1$/m);
    assert.doesNotMatch(
      failed.stdout + failed.stderr,
      /SyntaxError|ERR_MODULE_NOT_FOUND|node:test run\(\) is being called recursively/,
    );
  } finally {
    await writeFile(file, original);
  }
  passed(run(guard.kind));
  assert.deepEqual(await readFile(file), original);
  for (const [file, bytes] of originals)
    assert.deepEqual(await readFile(path.join(root, file)), bytes);
  const receipt = {
    id: guard.id,
    callback: "resource-release-readiness " + guard.kind + " acceptance",
    originalPassed: true,
    javascriptParsed: true,
    mutantFailedUnchangedAssertion: true,
    restoredPassed: true,
    mutantSha256: hash(mutant),
  };
  receipts.push(receipt);
  process.stderr.write(JSON.stringify(receipt) + "\n");
}
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "resource-release-readiness-guards-v1",
    controls: receipts,
    originalCallbacksUnchanged: true,
    mutatedBytesRestored: true,
    nativePosixCounterControlsIncluded: process.platform !== "win32",
    complete: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
