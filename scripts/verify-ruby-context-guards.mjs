import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-ruby.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "ruby-absolute-root-constant",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: 'kind === "constant" && qualifier === null && absolute',
    after: "false",
  },
  {
    id: "ruby-module-initialization",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before:
      'scope === "file" &&\n                !(name === "require_relative" && receiver === null)',
    after: "false",
  },
  {
    id: "ruby-unsupported-exported-method",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: "binding.unsupported = true;",
    after: "binding.unsupported = false;",
  },
  {
    id: "ruby-literal-values-only",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: 'target.binding.kind !== "constant" || !target.binding.literal',
    after: 'target.binding.kind !== "constant"',
  },
  {
    id: "ruby-exact-export-name",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: "binding.name === name &&",
    after: "binding.name.startsWith(name) &&",
  },
  {
    id: "ruby-exact-module-name",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: "modules.get(key(unit.revision, name)) ?? []",
    after: 'modules.get(key(unit.revision, "Policy")) ?? []',
  },
  {
    id: "ruby-duplicate-module",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before:
      "const values = modules.get(key(unit.revision, name)) ?? [];\n        if (values.length !== 1)",
    after:
      "const values = modules.get(key(unit.revision, name)) ?? [];\n        if (values.length === 0)",
  },
  {
    id: "ruby-duplicate-method",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: "function select(values, kind) {\n        if (values.length !== 1)",
    after: "function select(values, kind) {\n        if (values.length === 0)",
  },
  {
    id: "ruby-qualifier-constant-shadow",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: "if (!absolute &&\n            unit.bindings.some",
    after: "if (false &&\n            unit.bindings.some",
  },
  {
    id: "ruby-bare-parameter-mask",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: 'add(param, fn, "local", 0);',
    after: "ignore(param);",
  },
  {
    id: "ruby-assignment-parser-order",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: 'add(left, scope, "local", left.endIndex, {',
    after: 'add(left, scope, "local", node.endIndex, {',
  },
  {
    id: "ruby-explicit-method-parentheses",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: "unsupported: (receiver !== null &&",
    after:
      'unsupported: local(scope,name?.text??"",node.startIndex) || (receiver !== null &&',
  },
  {
    id: "ruby-unknown-value-receiver",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before:
      'receiver.type !== "self" &&\n                    qualifier === null',
    after: 'receiver.type !== "self" &&\n                    false',
  },
  {
    id: "ruby-opaque-scope",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: 'omit(scope, "unsupported-scope");',
    after: 'omit(scope, "unsupported-scope", false);',
  },
  {
    id: "ruby-opaque-loop-modifier",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: '"while_modifier",',
    after: '"missing_while_modifier",',
  },
  {
    id: "ruby-opaque-parameters",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: 'omit(fn, "unsupported-parameters");',
    after: 'omit(fn, "unsupported-parameters", false);',
  },
  {
    id: "ruby-metaprogramming",
    file: "review-ruby-bindings.js",
    name: "context-ruby near-miss acceptance",
    before: '"eval",',
    after: '"missing_eval",',
  },
  {
    id: "ruby-bare-method-capture",
    file: "review-polyglot.js",
    name: "context-ruby near-miss acceptance",
    before: "rubyUnit.calls.filter((call) => call.bare)",
    after: "rubyUnit.calls.filter(() => false)",
  },
  {
    id: "ruby-whole-decision",
    file: "review-polyglot.js",
    name: "context-ruby fixed acceptance",
    before: 'asset.grammar === "ruby" &&',
    after: 'asset.grammar === "missing_ruby" &&',
  },
  {
    id: "ruby-literal-import",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    before: 'file = raw.endsWith(".rb") ? raw : raw + ".rb"',
    after: 'file = raw.endsWith(".rb") ? raw : raw + ".missing"',
  },
  {
    id: "ruby-data-tail-omission",
    file: "review-ruby-bindings.js",
    name: "context-ruby stale acceptance",
    before: 'values.push("data-tail-unknown");',
    after: 'values.push("source-encoding-unknown");',
  },
  {
    id: "ruby-encoding-omission",
    file: "review-ruby-bindings.js",
    name: "context-ruby stale acceptance",
    before: 'values.push("source-encoding-unknown");',
    after: 'values.push("data-tail-unknown");',
  },
  {
    id: "ruby-root-intake",
    file: "review-ruby-resolution.js",
    name: "context-ruby stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "ruby-count-intake",
    file: "review-ruby-resolution.js",
    name: "context-ruby stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "ruby-outside-root-intake",
    file: "review-ruby-resolution.js",
    name: "context-ruby stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "ruby-closure",
    file: "review-python-resolution.js",
    name: "context-ruby broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "ruby-closure-intake",
    file: "review-ruby-resolution.js",
    name: "context-ruby stale acceptance",
    before:
      "JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges)",
    after: "false",
  },
  {
    id: "ruby-complete-call-range",
    file: "review-ruby-resolution.js",
    name: "context-ruby near-miss acceptance",
    edits: [
      {
        before: 'unit.calls.map((call) => [call.start + ":" + call.end, call])',
        after: "unit.calls.map((call) => [call.start, call])",
      },
      {
        before: 'captured.get(call.start + ":" + call.end)',
        after: "captured.get(call.start)",
      },
    ],
  },
  {
    id: "ruby-source-omission-intake",
    file: "review-ruby-resolution.js",
    name: "context-ruby stale acceptance",
    before:
      "mandatory.push(...rubySourceOmissions(source.path, source.content));",
    after: 'mandatory.push(...rubySourceOmissions(source.path, ""));',
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
const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((control) => control.id === id)),
  "Unknown guard control",
);
const evidence = [];
const baselines = new Map();
const originals = new Map();
for (const control of controls.filter(
  (control) => selected.size === 0 || selected.has(control.id),
)) {
  const source = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(source, "utf8");
  if (!baselines.has(control.name)) {
    const baseline = run(control.name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    baselines.set(control.name, baseline);
  }
  if (originals.has(source.href))
    assert.equal(
      originals.get(source.href),
      original,
      "A prior guard changed source bytes",
    );
  else originals.set(source.href, original);
  let mutant = original;
  for (const edit of control.edits ?? [control]) {
    assert.equal(
      mutant.split(edit.before).length,
      2,
      "Exact control address: " + control.id,
    );
    mutant = mutant.replace(edit.before, edit.after);
  }
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
  assert.equal(
    await readFile(source, "utf8"),
    original,
    "Original source bytes were not restored",
  );
}
for (const [source, original] of originals)
  assert.equal(
    await readFile(new URL(source), "utf8"),
    original,
    "Final source byte restoration failed",
  );
for (const name of baselines.keys()) {
  const restored = run(name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  for (const control of evidence.filter((control) => control.callback === name))
    control.restoredPassed = true;
}
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic Ruby captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
