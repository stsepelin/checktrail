import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-csharp.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "csharp-default-parameter-range",
    file: "review-polyglot.js",
    name: "context-csharp near-miss acceptance",
    before:
      'const equal = node.children.findIndex((child) => child.text === "=");',
    after: "const equal = -1;",
  },

  {
    id: "csharp-query-scope",
    file: "review-csharp-bindings.js",
    name: "context-csharp near-miss acceptance",
    before: '"query_expression",',
    after: '"missing_query_expression",',
  },
  {
    id: "csharp-anonymous-method-scope",
    file: "review-csharp-bindings.js",
    name: "context-csharp near-miss acceptance",
    before: '"anonymous_method_expression",',
    after: '"missing_anonymous_method_expression",',
  },
  {
    id: "csharp-nested-type-access",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: 'type.parent !== "file" && !type.public',
    after: "false",
  },
  {
    id: "csharp-alias-type-conflict",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: 'imported.kind === "alias" && imported.alias === first',
    after: 'imported.kind === "missing_alias" && imported.alias === first',
  },

  {
    id: "csharp-complete-call-range",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
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
    id: "csharp-local-function-forward",
    file: "review-csharp-bindings.js",
    name: "context-csharp near-miss acceptance",
    before:
      'node.type === "local_function_statement" ? "local-function" : "method", 0,',
    after:
      'node.type === "local_function_statement" ? "local-function" : "method", node.startIndex,',
  },
  {
    id: "csharp-delegate-parameter-mask",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: '(b.kind === "local" || b.kind === "local-function")',
    after: '(b.kind === "missing-local" || b.kind === "local-function")',
  },
  {
    id: "csharp-callable-field-mask",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: 'if (kind === "method" &&',
    after: "if (false &&",
  },
  {
    id: "csharp-own-method-priority",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before:
      "if (unit.bindings.some((b) => b.scope === s.id && b.kind === kind && b.name === name))",
    after: "if (false)",
  },
  {
    id: "csharp-literal-type-alias",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: 'i.kind === "alias" && i.alias === first',
    after: 'i.kind === "missing-alias" && i.alias === first',
  },
  {
    id: "csharp-namespace-import",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: 'i.kind === "namespace" && !i.unsupported && i.specifier !== null',
    after:
      'i.kind === "missing-namespace" && !i.unsupported && i.specifier !== null',
  },
  {
    id: "csharp-value-qualifier-mask",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: "if (shadowed(unit, scope, first, offset))",
    after: "if (false)",
  },
  {
    id: "csharp-absent-competing-static-import",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before:
      '? member(unit, scope, target.target, name, kind)\n                : { failure: "unsupported-dispatch" };',
    after:
      '? member(unit, scope, target.target, name, kind)\n                : { failure: "no-selected-definition" };',
  },
  {
    id: "csharp-overload-ambiguity",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before:
      "const values = target.unit.bindings.filter((b) => b.scope === target.type.scope && b.kind === kind && b.name === name);\n        if (values.length !== 1)",
    after:
      "const values = target.unit.bindings.filter((b) => b.scope === target.type.scope && b.kind === kind && b.name === name);\n        if (values.length === 0)",
  },
  {
    id: "csharp-duplicate-type-ambiguity",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before:
      "const values = types.get(key(unit.revision, name)) ?? [];\n        if (values.length !== 1)",
    after:
      "const values = types.get(key(unit.revision, name)) ?? [];\n        if (values.length === 0)",
  },
  {
    id: "csharp-named-argument-key",
    file: "review-csharp-bindings.js",
    name: "context-csharp near-miss acceptance",
    before: 'p.type === "argument" && field(p, "name")?.id === node.id',
    after: 'p.type === "missing_argument" && field(p, "name")?.id === node.id',
  },
  {
    id: "csharp-global-using-revision-boundary",
    file: "review-csharp-resolution.js",
    name: "context-csharp near-miss acceptance",
    before: "globalRevisions.has(unit.revision)",
    after: "false",
  },
  {
    id: "csharp-unicode-source-reconstruction",
    file: "review-csharp-resolution.js",
    name: "context-csharp stale acceptance",
    before: "mandatory.push(...csharpSourceOmissions(source.content));",
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "csharp-constructor-omission-reconstruction",
    file: "review-csharp-resolution.js",
    name: "context-csharp stale acceptance",
    before: 'mandatory.push("constructor-dispatch-unknown");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "csharp-root-reconstruction",
    file: "review-csharp-resolution.js",
    name: "context-csharp stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "csharp-count-reconciliation",
    file: "review-csharp-resolution.js",
    name: "context-csharp stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "csharp-outside-root-reconstruction",
    file: "review-csharp-resolution.js",
    name: "context-csharp stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "csharp-caller-closure",
    file: "review-python-resolution.js",
    name: "context-csharp broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "csharp-constructor-retention",
    file: "review-polyglot.js",
    name: "context-csharp near-miss acceptance",
    before: 'asset.grammar === "c_sharp" &&',
    after: 'asset.grammar === "missing_c_sharp" &&',
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
      "Original synthetic C# captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
