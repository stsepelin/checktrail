import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-rust.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "rust-grouped-self-alias",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before:
      'if (node.type !== "use_as_clause")\n                aliasNode = null;',
    after: "aliasNode = null;",
  },
  {
    id: "rust-constructor-value-namespace",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before: 'node.type === "struct_item" &&',
    after: "false &&",
  },
  {
    id: "rust-lexical-symbol-namespace",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before: '(value.namespace === namespace || value.namespace === "both")',
    after: "true",
  },
  {
    id: "rust-parameter-binding",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before: "locals.length && !moduleOnly",
    after: "false",
  },
  {
    id: "rust-let-initializer-visibility",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before: "value.visibleFrom <= offset",
    after: "true",
  },
  {
    id: "rust-target-module-attributes",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before: "contextFor(module.unit, module.scope) === null",
    after: "false",
  },
  {
    id: "rust-multi-root-ambiguity",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before:
      'if ([...memberships.values()].some((values) => values.length > 1))\n        omissions.add("ambiguous-definition");',
    after: 'if (false) omissions.add("ambiguous-definition");',
  },
  {
    id: "rust-label-reference-namespace",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before: '"label",',
    after: '"not_a_label",',
  },
  {
    id: "rust-lifetime-reference-namespace",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before: '"lifetime",',
    after: '"not_a_lifetime",',
  },
  {
    id: "rust-wildcard-no-binding",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before: 'else if (pattern?.type !== "_")',
    after: "else if (true)",
  },
  {
    id: "rust-literal-module-layout",
    file: "review-rust-resolution.js",
    name: "context-rust broken acceptance",
    before: 'directory + ".rs"',
    after: 'directory + ".missing"',
  },
  {
    id: "rust-duplicate-module-layout",
    file: "review-rust-resolution.js",
    name: "context-rust near-miss acceptance",
    before: "selected.length !== 1",
    after: "selected.length === 0",
  },
  {
    id: "rust-module-revision",
    file: "review-rust-resolution.js",
    name: "context-rust broken acceptance",
    before: "unit.revision === revision && candidates.includes(unit.file)",
    after: "candidates.includes(unit.file)",
  },
  {
    id: "rust-primary-caller-closure",
    file: "review-python-resolution.js",
    name: "context-rust broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "rust-root-reconstruction-binding",
    file: "review-rust-resolution.js",
    name: "context-rust stale acceptance",
    before: "JSON.stringify(bindings.crateRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "rust-summary-count-reconciliation",
    file: "review-rust-resolution.js",
    name: "context-rust stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "rust-missing-root-reconstruction",
    file: "review-rust-resolution.js",
    name: "context-rust stale acceptance",
    before: 'mandatory.push("missing-crate-root");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "rust-closure-parameter-binding",
    file: "review-rust-bindings.js",
    name: "context-rust near-miss acceptance",
    before: 'add(child, scopeNodes.get(node.parent.id), "local", "value");',
    after: "void child;",
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
  const source = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(source, "utf8");
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
      "Original synthetic Rust captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
