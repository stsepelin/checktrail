import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-swift.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-swift-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const guardCallback = new URL(
    "../dist/test/review-swift-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-swift selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-swift selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "swift-conditional-binding",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'if (node.type === "value_binding_pattern" &&',
    after: 'if (false && node.type === "value_binding_pattern" &&',
  },

  {
    id: "swift-parameter-mask",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: "declarationId: declarations.get(child.id)?.id ?? null,",
    after:
      'declarationId: declarations.get(child.id)?.id ?? null,name:"ignored",',
  },
  {
    id: "swift-local-binding-order",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: "top ? 0 : node.endIndex",
    after: "0",
  },
  {
    id: "swift-forward-function",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'add(name, scope, "function", 0, {',
    after: 'add(name, scope, "function", node.endIndex, {',
  },
  {
    id: "swift-default-enclosing-scope",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'fnIds.has(p.id) && within(node, field(p, "body"))',
    after: "fnIds.has(p.id)",
  },
  {
    id: "swift-opaque-exported-function",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: "binding.unsupported = true;",
    after: "binding.unsupported = false;",
  },
  {
    id: "swift-opaque-for",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: '"for_statement",',
    after: '"missing_for_statement",',
  },
  {
    id: "swift-opaque-parameters",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'omit(id, "unsupported-parameters");',
    after: 'omit(id, "unsupported-parameters", false);',
  },
  {
    id: "swift-literal-values-only",
    file: "review-swift-bindings.js",
    name: "context-swift selected bindings guard acceptance",
    before: "literal = value !== null &&",
    after: "literal = true || value !== null &&",
  },
  {
    id: "swift-exact-export-name",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: "binding.name === name &&",
    after: "binding.name.startsWith(name) &&",
  },
  {
    id: "swift-exact-module-label",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: "moduleOf(value) === name",
    after: "moduleOf(value)?.startsWith(name)",
  },
  {
    id: "swift-duplicate-function",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: "function select(values, kind) {\n        if (values.length !== 1)",
    after: "function select(values, kind) {\n        if (values.length === 0)",
  },
  {
    id: "swift-foreign-public-access",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'binding.access === "public"',
    after: "true",
  },
  {
    id: "swift-same-file-private-access",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: 'binding.access !== "file" || unit.file === from.file',
    after: "true",
  },
  {
    id: "swift-qualified-value-shadow",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
    before: "if (lexical.some((s) => unit.bindings.some",
    after: "if (false && lexical.some((s) => unit.bindings.some",
  },
  {
    id: "swift-parameter-owner",
    file: "review-swift-bindings.js",
    name: "context-swift broken acceptance",
    before: "declaration: owners[0]?.id ?? null,",
    after: "declaration: null,",
  },
  {
    id: "swift-argument-reads",
    file: "review-swift-bindings.js",
    name: "context-swift broken acceptance",
    before:
      "if (child.id !== value?.id)\n                        ignore(child);",
    after: "ignore(child);",
  },
  {
    id: "swift-root-intake",
    file: "review-swift-resolution.js",
    name: "context-swift stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "swift-count-intake",
    file: "review-swift-resolution.js",
    name: "context-swift stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "swift-outside-root-intake",
    file: "review-swift-resolution.js",
    name: "context-swift stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "swift-closure-intake",
    file: "review-swift-resolution.js",
    name: "context-swift stale acceptance",
    before:
      "JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges)",
    after: "false",
  },
  {
    id: "swift-source-omission-intake",
    file: "review-swift-resolution.js",
    name: "context-swift stale acceptance",
    before:
      "mandatory.push(...swiftSourceOmissions(source.path, source.content));",
    after: 'mandatory.push(...swiftSourceOmissions(source.path, ""));',
  },
  {
    id: "swift-manifest-omission",
    file: "review-swift-bindings.js",
    name: "context-swift stale acceptance",
    before: 'values.push("manifest-source-unknown");',
    after: 'values.push("conditional-source-unknown");',
  },
  {
    id: "swift-conditional-omission",
    file: "review-swift-bindings.js",
    name: "context-swift stale acceptance",
    before: 'values.push("conditional-source-unknown");',
    after: 'values.push("manifest-source-unknown");',
  },
  {
    id: "swift-closure",
    file: "review-python-resolution.js",
    name: "context-swift broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "swift-complete-call-range",
    file: "review-swift-resolution.js",
    name: "context-swift selected bindings guard acceptance",
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
      "Original synthetic Ruby captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
