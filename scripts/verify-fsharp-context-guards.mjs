import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-fsharp.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "fsharp-grouped-binding-scope",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before:
      'if (node.namedChildren.filter((child) => child.type === "function_declaration_left" ||\n                child.type === "value_declaration_left").length !== 1)',
    after: "if (false)",
  },
  {
    id: "fsharp-raw-attribute-boundary",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp stale acceptance",
    before: 'output.push("attributes-unknown");',
    after: 'output.push("conditional-source-unknown");',
  },
  {
    id: "fsharp-function-header-scope",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before:
      'unsupportedFsharpHeader(node) ||\n                node.text.includes("[<")',
    after: 'false ||\n                node.text.includes("[<")',
  },
  {
    id: "fsharp-value-header-mask",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: "unsupportedFsharpHeader(node) ||\n                name === null",
    after: "false ||\n                name === null",
  },
  {
    id: "fsharp-self-module-visibility",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: 'values[0].file !== unit.file && usable(values[0], "file")',
    after: 'usable(values[0], "file")',
  },
  {
    id: "fsharp-generic-header",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before:
      'left.namedChildren.some((child) => child.type === "type_arguments")',
    after: "false",
  },
  {
    id: "fsharp-computation-scope",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: '"ce_expression",',
    after: '"missing_ce_expression",',
  },
  {
    id: "fsharp-destructured-mask",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before:
      'omit(fn ?? scope, "unsupported-binding", fn === undefined && name === null);',
    after: 'omit(fn ?? scope, "unsupported-binding", false);',
  },
  {
    id: "fsharp-single-argument-scope",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: "args.namedChildren.length !== 1 ||",
    after: "false ||",
  },
  {
    id: "fsharp-parameter-mask",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: 'add(param, fn, "value", 0);',
    after: "ignore(param);",
  },
  {
    id: "fsharp-sequential-local-let",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: 'add(nameNode, scope, fn ? "function" : "value", node.endIndex, {',
    after: 'add(nameNode, scope, fn ? "function" : "value", 0, {',
  },
  {
    id: "fsharp-literal-value-name",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp broken acceptance",
    before: "declaration.name = name;",
    after: "declaration.name = null;",
  },
  {
    id: "fsharp-literal-value-only",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: 'target.binding.kind !== "value" || !target.binding.literal',
    after: 'target.binding.kind !== "value"',
  },
  {
    id: "fsharp-value-shadowing",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: "binding.name === name &&",
    after: 'binding.kind === "function" && binding.name === name &&',
  },
  {
    id: "fsharp-latest-open-priority",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: ".sort((a, b) => b.position - a.position);",
    after: ".sort((a, b) => a.position - b.position);",
  },
  {
    id: "fsharp-private-cross-file",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: "(target.binding.private && target.unit.file !== unit.file)",
    after: "false",
  },
  {
    id: "fsharp-duplicate-module",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before:
      "const values = modules.get(key(unit.revision, name)) ?? [];\n        if (values.length !== 1)",
    after:
      "const values = modules.get(key(unit.revision, name)) ?? [];\n        if (values.length === 0)",
  },
  {
    id: "fsharp-literal-alias",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before: 'imported.kind === "alias" &&',
    after: 'imported.kind === "missing_alias" &&',
  },
  {
    id: "fsharp-qualifier-value-mask",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before:
      "if (unit.bindings.some((binding) => binding.scope === current.id &&\n                binding.name === first &&\n                binding.visibleFrom <= offset))",
    after: "if (false)",
  },
  {
    id: "fsharp-missing-later-open",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
    before:
      '? "ambiguous-definition"\n                            : "unsupported-dispatch",',
    after:
      '? "ambiguous-definition"\n                            : "no-selected-definition",',
  },
  {
    id: "fsharp-complete-call-range",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp near-miss acceptance",
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
    id: "fsharp-script-omission",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: 'output.push("script-source-unknown");',
    after: 'output.push("conditional-source-unknown");',
  },
  {
    id: "fsharp-signature-omission",
    file: "review-fsharp-bindings.js",
    name: "context-fsharp near-miss acceptance",
    before: 'output.push("signature-source-unknown");',
    after: 'output.push("conditional-source-unknown");',
  },
  {
    id: "fsharp-source-omission-reconstruction",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp stale acceptance",
    before:
      "mandatory.push(...fsharpSourceOmissions(source.path, source.content));",
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "fsharp-root-reconstruction",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "fsharp-count-reconciliation",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "fsharp-outside-root-reconstruction",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "fsharp-caller-closure",
    file: "review-python-resolution.js",
    name: "context-fsharp broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "fsharp-caller-closure-reconstruction",
    file: "review-fsharp-resolution.js",
    name: "context-fsharp stale acceptance",
    before:
      "JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges)",
    after: "false",
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
      "Original synthetic F# captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
