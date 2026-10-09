import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-vb.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-vb-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const guardCallback = new URL(
    "../dist/test/review-vb-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-vb selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-vb selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "vb-case-folded-identifiers",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before:
      'const simple = (n) => n?.type === "identifier" && vbName(n) !== null && !n.text.includes(".")\n    ? n.text.toLowerCase()',
    after:
      'const simple = (n) => n?.type === "identifier" && vbName(n) !== null && !n.text.includes(".")\n    ? n.text',
  },
  {
    id: "vb-default-enclosing-scope",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "if (fnIds.has(p.id) && !defaultValue)",
    after: "if (fnIds.has(p.id))",
  },
  {
    id: "vb-parameter-mask",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: 'add(name, id, "local", {',
    after: 'if(false)add(name, id, "local", {',
  },
  {
    id: "vb-local-mask",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: 'add(name, scope, top ? "constant" : "local", {',
    after: 'if(top)add(name, scope, top ? "constant" : "local", {',
  },
  {
    id: "vb-literal-constant-provenance",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "literal = value !== null &&",
    after: "literal = true || value !== null &&",
  },
  {
    id: "vb-argument-reads",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "for (const child of n.namedChildren)\n            ignore(child);",
    after:
      "for (const child of n.namedChildren)\n            if(false)ignore(child);",
  },
  {
    id: "vb-default-read-owner",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "declaration: owners[0]?.id ?? null,",
    after: "declaration: null,",
  },
  {
    id: "vb-parameter-modes",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "!/\\b(?:ByRef|ParamArray)\\b/i.test(prefix)",
    after: "true",
  },
  {
    id: "vb-unknown-scope-propagation",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before: "if (unknown)\n            map.get(scope).unknown = true;",
    after: "if (false)\n            map.get(scope).unknown = true;",
  },
  {
    id: "vb-exported-function-scope",
    file: "review-vb-bindings.js",
    name: "context-vb selected bindings guard acceptance",
    before:
      "if (binding.functionId !== null && map.get(binding.functionId)?.unknown)",
    after:
      "if (false && binding.functionId !== null && map.get(binding.functionId)?.unknown)",
  },
  {
    id: "vb-qualified-receiver-mask",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before: '!usable(unit, scope) || masked(unit, scope, name.split(".")[0])',
    after: "!usable(unit, scope)",
  },
  {
    id: "vb-module-ambiguity",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before:
      'if (values.length !== 1)\n            return {\n                failure: values.length\n                    ? "ambiguous-definition"\n                    : "no-selected-definition",\n            };\n        const target = values[0];',
    after:
      'if (values.length === 0)\n            return {failure:"no-selected-definition"};\n        const target = values[0];',
  },
  {
    id: "vb-member-ambiguity",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before:
      'if (values.length !== 1)\n            return {\n                failure: values.length\n                    ? "ambiguous-definition"\n                    : "no-selected-definition",\n            };\n        const binding = values[0],',
    after:
      'if (values.length === 0)\n            return {failure:"no-selected-definition"};\n        const binding = values[0],',
  },
  {
    id: "vb-alias-ambiguity",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before: "if (aliases.length !== 1)",
    after: "if (aliases.length === 0)",
  },
  {
    id: "vb-private-module-member",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before: '(binding.access === "private" &&',
    after: '(false && binding.access === "private" &&',
  },
  {
    id: "vb-implicit-namespace-members",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before: "if (namespace !== undefined && namespace !== null) {",
    after: "if (false && namespace !== undefined && namespace !== null) {",
  },
  {
    id: "vb-own-module-priority",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
    before: "return member(unit, scope, caller, name, kind);",
    after: 'return {failure:"no-selected-definition"};',
  },
  {
    id: "vb-roots-intake",
    file: "review-vb-resolution.js",
    name: "context-vb stale acceptance",
    before:
      "if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
    after:
      "if(false && JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
  },
  {
    id: "vb-count-reconciliation",
    file: "review-vb-resolution.js",
    name: "context-vb stale acceptance",
    before: "if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
    after:
      "if(false && JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
  },
  {
    id: "vb-caller-closure-intake",
    file: "review-vb-resolution.js",
    name: "context-vb stale acceptance",
    before:
      "if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
    after:
      "if(false && JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))",
  },
  {
    id: "vb-omission-intake",
    file: "review-vb-resolution.js",
    name: "context-vb stale acceptance",
    edits: [
      {
        before: "if (mandatory.some((v) => !bindings.omissions.includes(v)) ||",
        after:
          "if (false && (mandatory.some((v) => !bindings.omissions.includes(v)) ||",
      },
      {
        before: '? "partial"\n                : "collected"))',
        after: '? "partial"\n                : "collected")))',
      },
    ],
  },
  {
    id: "vb-vb-parser-manifest-intake",
    file: "review-behavior-validation.js",
    name: "context-vb stale acceptance",
    before: "analysis.vbGrammarManifestDigest !== vbGrammarManifestDigest",
    after: "false",
  },
  {
    id: "vb-complete-call-range",
    file: "review-vb-resolution.js",
    name: "context-vb selected bindings guard acceptance",
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
      "Original synthetic Visual Basic captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
