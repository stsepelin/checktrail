import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-hcl.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const boundaryFixture = new URL(
    "../dist/test/review-hcl-boundaries-fixture.js",
    import.meta.url,
  ),
  originalBoundaryFixture = await readFile(boundaryFixture);

const nameFixture = new URL(
    "../dist/test/review-name-boundaries-fixture.js",
    import.meta.url,
  ),
  originalNameFixture = await readFile(nameFixture);
const guardCallback = new URL(
    "../dist/test/review-hcl-boundaries.test.js",
    import.meta.url,
  ),
  originalGuardCallback = await readFile(guardCallback);
const callbackFor = (name) =>
  name === "context-hcl selected bindings guard acceptance"
    ? guardCallback
    : callback;
const callbackBytes = (name) =>
  name === "context-hcl selected bindings guard acceptance"
    ? originalGuardCallback
    : originalCallback;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "hcl-long-label-unknown",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "&& decl.name === null)",
    after: '&& decl.name === "")',
  },
  {
    id: "hcl-long-local-unknown",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      'if (name === null)\n                    omit("unsupported-expression");',
    after: "if (name === null)\n                    void 0;",
  },

  {
    id: "hcl-identifier-name-bound",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "node.text.length <= 256 &&",
    after: "node.text.length <= 257 &&",
  },
  {
    id: "hcl-label-name-bound",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "name !== null && name.length <= 256 ? name : null",
    after: "name !== null && name.length <= 257 ? name : null",
  },

  {
    id: "hcl-identifier-case",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "binding.kind === namespace && binding.name === name",
    after:
      "binding.kind === namespace && binding.name.toLowerCase() === name.toLowerCase()",
  },
  {
    id: "hcl-identifier-prefix",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "binding.kind === namespace && binding.name === name",
    after: "binding.kind === namespace && name.startsWith(binding.name)",
  },
  {
    id: "hcl-namespace",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "binding.kind === namespace && binding.name === name",
    after: "binding.name === name",
  },
  {
    id: "hcl-directory",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      "path.posix.dirname(value.file) === path.posix.dirname(unit.file) &&",
    after: "true &&",
  },
  {
    id: "hcl-revision",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before: "value.revision === unit.revision &&",
    after: "true &&",
  },
  {
    id: "hcl-two-part-traversal",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "value.segments.length === 2",
    after: "value.segments.length >= 2",
  },
  {
    id: "hcl-module-name",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: ".filter((module) => module.name === name)",
    after: ".filter((module) => name.startsWith(module.name))",
  },
  {
    id: "hcl-output-case",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: 'binding.kind === "output" && binding.name === member',
    after:
      'binding.kind === "output" && binding.name.toLowerCase() === member.toLowerCase()',
  },
  {
    id: "hcl-ambiguity",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "candidates.length === 1",
    after: "candidates.length >= 1",
  },
  {
    id: "hcl-module-cardinality",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      'attributes.some((c) => ["count", "for_each", "providers", "version"].includes(identifier(child(c, "identifier")) ?? ""))',
    after: "false",
  },
  {
    id: "hcl-absolute-module",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "if (path.posix.isAbsolute(value.specifier))",
    after: "if (false)",
  },
  {
    id: "hcl-escaping-module",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: 'directory.startsWith("../") ||\n            directory === ".." ||',
    after: "false ||",
  },
  {
    id: "hcl-remote-module",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "if (!/^\\.\\.?\\/[A-Za-z_0-9./-]+$/.test(value.specifier))",
    after: "if (false)",
  },
  {
    id: "hcl-module-files",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "target.units.map((unit) => unit.file).sort()",
    after: "target.units.map((unit) => unit.file).sort().slice(0,1)",
  },
  {
    id: "hcl-complex-expression",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "unsupported ||= complex.has(parent.id);",
    after: "unsupported ||= false;",
  },
  {
    id: "hcl-index-expression",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: '["index", "splat"].includes(next?.type ?? "")',
    after: "false",
  },
  {
    id: "hcl-application-block",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      '!top(scope) ||\n                !["variable", "locals", "output", "module"].includes(identifier(scope.namedChildren[0]) ?? "")',
    after: "false",
  },
  {
    id: "hcl-type-expression",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: 'identifier(attribute.namedChildren[0]) === "type")',
    after: "false)",
  },
  {
    id: "hcl-output-owner",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      'const owner = outputOwner ?? owners.find((d) => d.kind === "property") ?? owners[0];',
    after:
      'const owner = owners.find((d) => d.kind === "property") ?? owners[0];',
  },
  {
    id: "hcl-complete-traversal",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before: "end: range(end).end,",
    after: "end: range(node).end,",
  },
  {
    id: "hcl-variable-default",
    file: "review-hcl-bindings.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      'initializer: attribute ? child(attribute, "expression") : undefined,',
    after: "initializer: undefined,",
  },
  {
    id: "hcl-dependency-cycle",
    file: "review-hcl-resolution.js",
    name: "context-hcl selected bindings guard acceptance",
    before:
      'if (closure.cycle)\n        omissions.add("dependency-cycle-unknown");',
    after: 'if (false)\n        omissions.add("dependency-cycle-unknown");',
  },
  {
    id: "hcl-dependency-depth",
    file: "review-hcl-resolution.js",
    name: "context-hcl empty acceptance",
    before: "if (depth > 8)",
    after: "if (depth > 7)",
  },
  {
    id: "hcl-roots-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before:
      "if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))",
    after: "if (false)",
  },
  {
    id: "hcl-counts-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before: "if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))",
    after: "if (false)",
  },
  {
    id: "hcl-module-files-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before:
      "JSON.stringify(candidate.targetFiles) !== JSON.stringify(targetFiles) ||",
    after: "false ||",
  },
  {
    id: "hcl-references-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before:
      "if (JSON.stringify(publicReferences.map(referenceKey)) !==\n        JSON.stringify(resolvedReferences.map(referenceKey)))",
    after: "if (false)",
  },
  {
    id: "hcl-omissions-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before:
      'if (mandatory.some((reason) => !bindings.omissions.includes(reason)) ||\n        JSON.stringify(bindings.omissions) !==\n            JSON.stringify([...new Set(bindings.omissions)].sort()) ||\n        bindings.state !==\n            (bindings.omissions.some((reason) => !fixed.includes(reason))\n                ? "partial"\n                : "collected"))',
    after: "if (false)",
  },
  {
    id: "hcl-closure-intake",
    file: "review-hcl-resolution.js",
    name: "context-hcl stale acceptance",
    before:
      "if (JSON.stringify(bindings.dependencyEdges) !== JSON.stringify(closure.edges))",
    after: "if (false)",
  },
  {
    id: "hcl-grammar-intake",
    file: "review-behavior-validation.js",
    name: "context-hcl stale acceptance",
    before: "analysis.grammarManifestDigest !== grammarManifestDigest",
    after: "false",
  },
  {
    id: "hcl-whole-conditional",
    file: "review-polyglot.js",
    name: "context-hcl selected bindings guard acceptance",
    before: '    "conditional_expression",\n    "conditional",',
    after: '    "conditional_expression",',
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
    assert.match(result.stdout, /ERR_ASSERTION/, control.id);
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
      "Original synthetic HCL captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
