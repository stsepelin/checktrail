import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-c.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-c-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const nameFixture = new URL(
    "../dist/test/review-name-boundaries-fixture.js",
    import.meta.url,
  ),
  originalNameFixture = await readFile(nameFixture);
const guardCallback = new URL(
    "../dist/test/review-c-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-c selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-c selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "c-long-read-unknown",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "node.text.length > 256",
    after: "node.text.length > 257",
  },

  {
    id: "c-identifier-name-bound",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "node.text.length <= 256 &&",
    after: "node.text.length <= 257 &&",
  },

  {
    id: "c-identifier-case",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    edits: [
      {
        before: "b.name === name &&",
        after: "b.name.toLowerCase() === name.toLowerCase() &&",
      },
      {
        before: "v.binding.name === name",
        after: "v.binding.name.toLowerCase() === name.toLowerCase()",
      },
    ],
  },
  {
    id: "c-identifier-prefix",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "v.binding.name === name",
    after: "name.startsWith(v.binding.name)",
  },
  {
    id: "c-point-of-declaration",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "visibleFrom: node.endIndex,",
    after: "visibleFrom: 0,",
  },
  {
    id: "c-parameter-mask",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: 'add(pname, id, "local", { visibleFrom: 0 });',
    after: '{if(false)add(pname, id, "local", { visibleFrom: 0 });}',
  },
  {
    id: "c-local-mask",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: 'add(name, scope, constant ? "constant" : "local", {',
    after: 'if(constant)add(name, scope, constant ? "constant" : "local", {',
  },
  {
    id: "c-literal-constant",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "const literal = value !== null &&",
    after: "const literal = true || value !== null &&",
  },
  {
    id: "c-header-and-body-node-identity",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (child.id !== body?.id)",
    after: "if (child !== body)",
  },
  {
    id: "c-nested-block-scope",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (scopeIds.has(p.id))",
    after: 'if (scopeIds.has(p.id) && p.type === "function_definition")',
  },
  {
    id: "c-initializer-read-owner",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "declaration: owners[0]?.id ?? null,",
    after: "declaration: null,",
  },
  {
    id: "c-scope-uncertainty",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (unknown)\n            map.get(scope).unknown = true;",
    after: "if (false)\n            map.get(scope).unknown = true;",
  },
  {
    id: "c-exported-function-uncertainty",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before:
      "if (binding.functionId !== null && map.get(binding.functionId)?.unknown)",
    after:
      "if (false && binding.functionId !== null && map.get(binding.functionId)?.unknown)",
  },
  {
    id: "c-prototype-mask",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before:
      'add(declaratorName(child), scope, "prototype", { unsupported: true });',
    after:
      'if(false)add(declaratorName(child), scope, "prototype", { unsupported: true });',
  },
  {
    id: "c-include-position",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "unit.imports.filter((value) => value.end <= position)",
    after: "unit.imports.filter((value) => true)",
  },
  {
    id: "c-unselected-header-uncertainty",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (expanded.unknown)",
    after: "if (false)",
  },
  {
    id: "c-include-depth",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "depth >= 8 || visited.has(id)",
    after: "false || visited.has(id)",
  },
  {
    id: "c-include-visit-budget",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "budget.remaining-- <= 0",
    after: "false",
  },
  {
    id: "c-definition-ambiguity",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (values.length !== 1)",
    after: "if (values.length === 0)",
  },
  {
    id: "c-source-call-owner",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "call.callerFunctionId = source?.caller ?? null;",
    after: "call.callerFunctionId = null;",
  },
  {
    id: "c-complete-call-range",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
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
    id: "c-roots-intake",
    file: "review-c-resolution.js",
    name: "context-c stale acceptance",
    before:
      "if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
    after:
      "if(false && JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
  },
  {
    id: "c-counts-intake",
    file: "review-c-resolution.js",
    name: "context-c stale acceptance",
    before: "if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
    after:
      "if(false && JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
  },
  {
    id: "c-closure-intake",
    file: "review-c-resolution.js",
    name: "context-c stale acceptance",
    before:
      "if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
    after:
      "if(false && JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
  },
  {
    id: "c-omissions-intake",
    file: "review-c-resolution.js",
    name: "context-c stale acceptance",
    before:
      '    if (mandatory.some((v) => !bindings.omissions.includes(v)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((o) => !fixed.includes(o))\n                ? "partial"\n                : "collected"))\n',
    after:
      '    if (false && (mandatory.some((v) => !bindings.omissions.includes(v)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((o) => !fixed.includes(o))\n                ? "partial"\n                : "collected")))\n',
  },
  {
    id: "c-grammar-manifest-intake",
    file: "review-behavior-validation.js",
    name: "context-c stale acceptance",
    before: "analysis.grammarManifestDigest !== grammarManifestDigest",
    after: "false",
  },
  {
    id: "c-absolute-include",
    file: "review-c-resolution.js",
    name: "context-c selected bindings guard acceptance",
    before: "if (path.posix.isAbsolute(imported.specifier))",
    after: "if (false)",
  },
  {
    id: "c-inert-directive-comment",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "/m.test(preprocessing)",
    after: "/m.test(source)",
  },
  {
    id: "c-unevaluated-size-read",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: 'node.type === "sizeof_expression" ||',
    after: "false ||",
  },
  {
    id: "c-address-is-not-a-read",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: '(node.type === "pointer_expression" &&',
    after: "(false &&",
  },
  {
    id: "c-vla-scope",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: 'else if (node.type === "array_declarator")',
    after: "else if (false)",
  },
  {
    id: "c-local-declarator-completion",
    file: "review-c-bindings.js",
    name: "context-c selected bindings guard acceptance",
    before: "visibleFrom: dec?.endIndex ?? node.endIndex,",
    after: "visibleFrom: 0,",
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
    assert.deepEqual(
      await readFile(nameFixture),
      originalNameFixture,
      "Original name-boundary assertions changed",
    );
    evidence.push({
      id: control.id,
      callback: control.name,
      callbackSha256: digest(callbackBytes(control.name)),
      fixtureSha256: digest(originalBoundaryFixture),
      nameFixtureSha256: digest(originalNameFixture),
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
      "Original synthetic C captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
