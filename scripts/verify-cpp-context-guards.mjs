import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-cpp.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-cpp-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const guardCallback = new URL(
    "../dist/test/review-cpp-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-cpp selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-cpp selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "cpp-identifier-case",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    edits: [
      {
        before: "binding.name === name &&",
        after: "binding.name.toLowerCase() === name.toLowerCase() &&",
      },
      {
        before: 'value.binding.scope === "file" && value.binding.name === name',
        after:
          'value.binding.scope === "file" && value.binding.name.toLowerCase() === name.toLowerCase()',
      },
    ],
  },
  {
    id: "cpp-identifier-prefix",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'value.binding.scope === "file" && value.binding.name === name',
    after:
      'value.binding.scope === "file" && name.startsWith(value.binding.name)',
  },
  {
    id: "cpp-point-of-declaration",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "kind,\n            visibleFrom: node.endIndex,",
    after: "kind,\n            visibleFrom: 0,",
  },
  {
    id: "cpp-parameter-mask",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'add(pname, id, "local", { visibleFrom: 0 });',
    after: '{if(false)add(pname, id, "local", { visibleFrom: 0 });}',
  },
  {
    id: "cpp-local-mask",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'add(name, scope, constant ? "constant" : "local", {',
    after: 'if(constant)add(name, scope, constant ? "constant" : "local", {',
  },
  {
    id: "cpp-literal-constant",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "const literal = value !== null &&",
    after: "const literal = true || value !== null &&",
  },
  {
    id: "cpp-header-and-body-node-identity",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (child.id !== body?.id)",
    after: "if (child !== body)",
  },
  {
    id: "cpp-nested-block-scope",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (scopeIds.has(p.id))",
    after: 'if (scopeIds.has(p.id) && p.type === "function_definition")',
  },
  {
    id: "cpp-initializer-read-owner",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "declaration: owners[0]?.id ?? null,",
    after: "declaration: null,",
  },
  {
    id: "cpp-scope-uncertainty",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (unknown)\n            map.get(scope).unknown = true;",
    after: "if (false)\n            map.get(scope).unknown = true;",
  },
  {
    id: "cpp-exported-function-uncertainty",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before:
      "if (binding.functionId !== null && map.get(binding.functionId)?.unknown)",
    after:
      "if (false && binding.functionId !== null && map.get(binding.functionId)?.unknown)",
  },
  {
    id: "cpp-prototype-mask",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before:
      'add(declaratorName(child), scope, "prototype", { unsupported: true });',
    after:
      'if(false)add(declaratorName(child), scope, "prototype", { unsupported: true });',
  },
  {
    id: "cpp-include-position",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "unit.imports.filter((value) => value.end <= position)",
    after: "unit.imports.filter((value) => true)",
  },
  {
    id: "cpp-unselected-header-uncertainty",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (expanded.unknown)",
    after: "if (false)",
  },
  {
    id: "cpp-include-depth",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "depth >= 8 || visited.has(id)",
    after: "false || visited.has(id)",
  },
  {
    id: "cpp-include-visit-budget",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "budget.remaining-- <= 0",
    after: "false",
  },
  {
    id: "cpp-definition-ambiguity",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (values.length !== 1)",
    after: "if (values.length === 0)",
  },
  {
    id: "cpp-source-call-owner",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "call.callerFunctionId = source?.caller ?? null;",
    after: "call.callerFunctionId = null;",
  },
  {
    id: "cpp-complete-call-range",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
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
    id: "cpp-roots-intake",
    file: "review-cpp-resolution.js",
    name: "context-cpp stale acceptance",
    before:
      "if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
    after:
      "if(false && JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
  },
  {
    id: "cpp-counts-intake",
    file: "review-cpp-resolution.js",
    name: "context-cpp stale acceptance",
    before: "if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
    after:
      "if(false && JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
  },
  {
    id: "cpp-closure-intake",
    file: "review-cpp-resolution.js",
    name: "context-cpp stale acceptance",
    before:
      "if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
    after:
      "if(false && JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
  },
  {
    id: "cpp-omissions-intake",
    file: "review-cpp-resolution.js",
    name: "context-cpp stale acceptance",
    before:
      '    if (mandatory.some((v) => !bindings.omissions.includes(v)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((o) => !fixed.includes(o))\n                ? "partial"\n                : "collected"))\n',
    after:
      '    if (false && (mandatory.some((v) => !bindings.omissions.includes(v)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((o) => !fixed.includes(o))\n                ? "partial"\n                : "collected")))\n',
  },
  {
    id: "cpp-grammar-manifest-intake",
    file: "review-behavior-validation.js",
    name: "context-cpp stale acceptance",
    before: "analysis.grammarManifestDigest !== grammarManifestDigest",
    after: "false",
  },
  {
    id: "cpp-absolute-include",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (path.posix.isAbsolute(imported.specifier))",
    after: "if (false)",
  },
  {
    id: "cpp-inert-directive-comment",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "/m.test(preprocessing)",
    after: "/m.test(source)",
  },
  {
    id: "cpp-unevaluated-size-read",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'node.type === "sizeof_expression" ||',
    after: "false ||",
  },
  {
    id: "cpp-address-is-not-a-read",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: '(node.type === "pointer_expression" &&',
    after: "(false &&",
  },
  {
    id: "cpp-vla-scope",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'else if (node.type === "array_declarator")',
    after: "else if (false)",
  },
  {
    id: "cpp-local-declarator-completion",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before:
      "literal: constant && literal,\n                    visibleFrom: dec?.endIndex ?? node.endIndex,",
    after: "literal: constant && literal,\n                    visibleFrom: 0,",
  },

  {
    id: "cpp-default-enclosing-scope",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'parent: owner ? scopeFor(owner) : "file",',
    after: 'parent: owner ? fnIds.get(owner.id) : "file",',
  },
  {
    id: "cpp-default-earlier-parameter-mask",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "later.startIndex > parameter.startIndex &&",
    after: "false &&",
  },
  {
    id: "cpp-default-current-parameter-scope",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "later.startIndex > parameter.startIndex &&",
    after: "later.startIndex >= parameter.startIndex &&",
  },
  {
    id: "cpp-default-expression-reads",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (!node || defaultExpressions.has(node.id))",
    after: "if (!node)",
  },
  {
    id: "cpp-function-declarator-completion",
    file: "review-cpp-bindings.js",
    name: "context-cpp selected bindings guard acceptance",
    before:
      "visibleFrom: dec?.endIndex ?? node.endIndex,\n                functionId: id,",
    after: "visibleFrom: 0,\n                functionId: id,",
  },
  {
    id: "cpp-selected-header-alias",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "aliases.push(...nested.aliases);",
    after: "if(false)aliases.push(...nested.aliases);",
  },
  {
    id: "cpp-alias-position",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: 'alias.scope === "file" && alias.visibleFrom <= position',
    after: 'alias.scope === "file"',
  },
  {
    id: "cpp-alias-ambiguity",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "if (aliases.length !== 1)",
    after: "if (aliases.length === 0)",
  },
  {
    id: "cpp-alias-depth",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "depth < 8;",
    after: "depth < 16;",
  },
  {
    id: "cpp-namespace-own-priority",
    file: "review-cpp-resolution.js",
    name: "context-cpp selected bindings guard acceptance",
    before: "value.binding.scope === current.id && value.binding.name === name",
    after: 'value.binding.scope === "file" && value.binding.name === name',
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
      fileURLToPath(callbackFor(name)),
    ],
    {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 90000,
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
      await readFile(callbackFor(control.name)),
      callbackBytes(control.name),
      "Original callback changed",
    );
    assert.deepEqual(
      await readFile(boundaryFixture),
      originalBoundaryFixture,
      "Original boundary assertions changed",
    );
    evidence.push({
      id: control.id,
      callback: control.name,
      callbackSha256: digest(callbackBytes(control.name)),
      fixtureSha256: digest(originalBoundaryFixture),
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
      "Original synthetic C++ captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
