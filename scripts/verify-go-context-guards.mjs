import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-go.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "go-complete-call-range",
    file: "review-go-resolution.js",
    name: "context-go near-miss acceptance",
    before: 'call.start + ":" + call.end',
    after: "call.start",
    occurrences: 2,
  },
  {
    id: "go-module-block-rejection",
    file: "go-workspace.js",
    name: "context-go empty acceptance",
    before:
      'if (rows(text).some((row) => row[0] === "module" && row.includes("(")))',
    after: "if (false)",
  },
  {
    id: "go-unknown-implicit-import",
    file: "review-go-resolution.js",
    name: "context-go near-miss acceptance",
    before:
      "unit.imports.some((imported) => imported.alias === null &&\n            selected(unit, imported.specifier).group === null)",
    after: "false",
  },
  {
    id: "go-parameter-shadowing",
    file: "review-go-bindings.js",
    name: "context-go near-miss acceptance",
    before: 'add(parameterName, id, 0, "other",',
    after: 'add(parameterName, "file", 0, "other",',
  },
  {
    id: "go-local-declaration-visibility",
    file: "review-go-bindings.js",
    name: "context-go near-miss acceptance",
    before:
      'add(name, scope, node.endIndex, "other", null, declarations.get(node.id)?.id ?? null)',
    after:
      'add(name, scope, 0, "other", null, declarations.get(node.id)?.id ?? null)',
  },
  {
    id: "go-import-file-namespace",
    file: "review-go-resolution.js",
    name: "context-go near-miss acceptance",
    before:
      'unit.bindings.some((binding) => binding.scope === "file" && binding.name === name)',
    after: '!("failure" in own && own.failure === "no-selected-definition")',
  },
  {
    id: "go-duplicate-package-identity",
    file: "review-go-resolution.js",
    name: "context-go near-miss acceptance",
    before: "if (previous && previous !== group)",
    after: "if (false)",
  },
  {
    id: "go-primary-caller-closure",
    file: "review-python-resolution.js",
    name: "context-go broken acceptance",
    before: "analysis.functions.filter((fn) => primary.includes(fn.file))",
    after: "analysis.functions.filter(() => false)",
  },
  {
    id: "go-manifest-reconstruction-binding",
    file: "review-go-resolution.js",
    name: "context-go stale acceptance",
    before:
      "JSON.stringify(bindings.moduleManifests) !== JSON.stringify(manifests)",
    after: "false",
  },
  {
    id: "go-summary-count-reconciliation",
    file: "review-go-resolution.js",
    name: "context-go stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
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
for (const control of controls.filter(
  (control) => selected.size === 0 || selected.has(control.id),
)) {
  const source = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(source, "utf8");
  const baseline = run(control.name);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.equal(
    original.split(control.before).length,
    (control.occurrences ?? 1) + 1,
    "Exact control address: " + control.id,
  );
  const mutant = original.replaceAll(control.before, control.after);
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
      "Original synthetic Go captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
