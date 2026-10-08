import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-java.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "java-method-reference-receiver",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: "parent.namedChildren.at(-1)?.id === node.id",
    after: "true",
  },
  {
    id: "java-enclosing-type-accessibility",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before: "target.unit.packageName !== unit.packageName &&",
    after: "false &&",
  },
  {
    id: "java-unicode-preprocessing-boundary",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: 'nodes[0].text.includes("\\\\u")',
    after: "false",
  },
  {
    id: "java-unicode-source-reconstruction",
    file: "review-java-resolution.js",
    name: "context-java stale acceptance",
    before: 'mandatory.push("unicode-escapes-unknown");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "java-constructor-omission-reconstruction",
    file: "review-java-resolution.js",
    name: "context-java stale acceptance",
    before: 'mandatory.push("constructor-dispatch-unknown");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "java-complete-call-range",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    edits: [
      {
        before: 'c.start + ":" + c.end',
        after: "c.start",
      },
      {
        before: 'call.start + ":" + call.end',
        after: "call.start",
      },
    ],
  },
  {
    id: "java-local-type-visibility",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: 'byScope.get(scope)?.kind === "block" ? node.startIndex : 0',
    after: "0",
  },
  {
    id: "java-competing-absent-import",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before: "(!i.static || types.has(key(unit.revision, i.specifier)))",
    after: "types.has(key(unit.revision, i.specifier))",
  },
  {
    id: "java-retained-constructor-dispatch",
    file: "review-polyglot.js",
    name: "context-java near-miss acceptance",
    before: 'node.type === "object_creation_expression";',
    after: 'node.type === "missing_constructor_expression";',
  },
  {
    id: "java-method-reference-name",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: 'parent.type === "method_reference"',
    after: 'parent.type === "missing_method_reference"',
  },
  {
    id: "java-local-own-initializer",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: '"local", node.startIndex',
    after: '"local", node.endIndex',
  },
  {
    id: "java-method-value-namespace",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before: 'if (kind === "field" &&',
    after: "if (true &&",
  },
  {
    id: "java-value-qualifier-boundary",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before: "if (shadowed(unit, scope, first, offset))",
    after: "if (false)",
  },
  {
    id: "java-member-overload-ambiguity",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before:
      "const values = target.unit.bindings.filter((b) => b.scope === target.type.scope && b.kind === kind && b.name === name);\n        if (values.length !== 1)",
    after:
      "const values = target.unit.bindings.filter((b) => b.scope === target.type.scope && b.kind === kind && b.name === name);\n        if (values.length === 0)",
  },
  {
    id: "java-duplicate-type-ambiguity",
    file: "review-java-resolution.js",
    name: "context-java near-miss acceptance",
    before:
      "const values = types.get(key(unit.revision, name)) ?? [];\n        if (values.length !== 1)",
    after:
      "const values = types.get(key(unit.revision, name)) ?? [];\n        if (values.length === 0)",
  },
  {
    id: "java-label-use-namespace",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: '["break_statement", "continue_statement"].includes(parent.type)',
    after: "false",
  },
  {
    id: "java-label-declaration-namespace",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: 'parent.type === "labeled_statement"',
    after: 'parent.type === "missing_labeled_statement"',
  },
  {
    id: "java-inheritance-unknown",
    file: "review-java-bindings.js",
    name: "context-java near-miss acceptance",
    before: 'field(node, "superclass") !== null',
    after: "false",
  },
  {
    id: "java-primary-caller-closure",
    file: "review-python-resolution.js",
    name: "context-java broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "java-root-reconstruction-binding",
    file: "review-java-resolution.js",
    name: "context-java stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "java-summary-count-reconciliation",
    file: "review-java-resolution.js",
    name: "context-java stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "java-outside-root-reconstruction",
    file: "review-java-resolution.js",
    name: "context-java stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
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
      "Original synthetic Java captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
