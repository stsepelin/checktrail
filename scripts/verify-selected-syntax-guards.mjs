import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const source = new URL("../dist/src/review-polyglot.js", import.meta.url);
const callback = new URL(
  "../dist/test/review-polyglot.test.js",
  import.meta.url,
);
const original = await readFile(source, "utf8"),
  originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "whole-function-retention",
    name: "selected syntax retains whole functions decisions and declaration defaults across every pinned grammar",
    before: "nodes.filter(isFunction)",
    after: "nodes.filter(() => false)",
  },
  {
    id: "decision-retention",
    name: "selected syntax retains whole functions decisions and declaration defaults across every pinned grammar",
    before: "decisions.has(node.type)",
    after: "false",
  },
  {
    id: "default-retention",
    name: "selected syntax retains whole functions decisions and declaration defaults across every pinned grammar",
    before: "initial = initializer(node, kind)",
    after: "initial = undefined",
  },
  {
    id: "grammar-byte-binding",
    name: "selected syntax reports missing or changed grammar prerequisites before parsing captured source",
    before:
      "bytes.length !== grammar.bytes || bytesHash(bytes) !== grammar.sha256",
    after: "false",
  },
  {
    id: "base-function-retention",
    name: "selected syntax keeps immutable base index and working views distinct across moves and deletions",
    before: '["base", base]',
    after: '["base", []]',
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
for (const control of controls) {
  const baseline = run(control.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.equal(
    original.split(control.before).length,
    2,
    "Exact control address: " + control.id,
  );
  const mutant = original.replace(control.before, control.after);
  try {
    await writeFile(source, mutant);
    const compile = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(source)],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    const result = run(control.name);
    assert.equal(
      result.status,
      1,
      "Original assertion must kill " +
        control.id +
        "\n" +
        result.stdout +
        result.stderr,
    );
    assert.match(result.stdout, /ERR_ASSERTION/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(result.stdout.includes("not ok 1 - " + control.name));
    assert.deepEqual(
      await readFile(callback),
      originalCallback,
      "Original callback changed",
    );
    evidence.push({
      id: control.id,
      callback: control.name,
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
  const restored = run(control.name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  evidence.at(-1).restoredPassed = true;
}
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic captured-syntax controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
