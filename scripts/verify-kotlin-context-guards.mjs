import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
  "../dist/test/gate-context-kotlin.test.js",
  import.meta.url,
);
const originalCallback = await readFile(callback);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const controls = [
  {
    id: "kotlin-generated-output-exclusion",
    file: "review.js",
    name: "context-kotlin near-miss acceptance",
    edits: [
      {
        before: "!inventorySourcePath(file)",
        after: "false",
      },
      {
        before:
          "before.excluded.some((excluded) => file === excluded || file.startsWith(`${excluded}/`))",
        after: "false",
      },
      {
        before: "!before.files.includes(file)",
        after: "false",
      },
    ],
  },
  {
    id: "kotlin-complete-call-range",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin near-miss acceptance",
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
    id: "kotlin-local-function-order",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    before: "local ? node.startIndex : 0",
    after: "0",
  },
  {
    id: "kotlin-callable-value-shadow",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin near-miss acceptance",
    before: "if (values.length)\n                return select(",
    after:
      'if (values.some(value => value.kind === "function"))\n                return select(',
  },
  {
    id: "kotlin-exact-import-alias",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin near-miss acceptance",
    before: "unit.imports.filter((i) => i.alias === name)",
    after: 'unit.imports.filter((i) => name.startsWith(i.alias ?? "!"))',
  },
  {
    id: "kotlin-native-overload-ambiguity",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin near-miss acceptance",
    before: "if (values.length !== 1)",
    after: "if (values.length === 0)",
  },
  {
    id: "kotlin-file-private-access",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin near-miss acceptance",
    before: "(target.binding.private && target.unit.file !== unit.file)",
    after: "false",
  },
  {
    id: "kotlin-type-receiver-boundary",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    before: 'node.childForFieldName("receiver") !== null',
    after: "false",
  },
  {
    id: "kotlin-lambda-implicit-receiver",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    before: 'kind === "lambda" ||',
    after: "false ||",
  },
  {
    id: "kotlin-callable-reference-name",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    before: '"callable_reference",',
    after: '"missing_callable_reference",',
  },
  {
    id: "kotlin-named-argument-key",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    before: 'p.type === "value_argument" &&',
    after: "false &&",
  },
  {
    id: "kotlin-script-loading-producer",
    file: "review-kotlin-bindings.js",
    name: "context-kotlin near-miss acceptance",
    edits: [
      {
        before: 'unknown: address.file.endsWith(".kts"),',
        after: "unknown: false,",
      },
      { before: 'if (address.file.endsWith(".kts"))', after: "if (false)" },
    ],
  },
  {
    id: "kotlin-roots-reconstruction",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin stale acceptance",
    before: "JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots)",
    after: "false",
  },
  {
    id: "kotlin-counts-reconstruction",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin stale acceptance",
    before: "JSON.stringify(counts) !== JSON.stringify(bindings.counts)",
    after: "false",
  },
  {
    id: "kotlin-closure-reconstruction",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin stale acceptance",
    before:
      "JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges)",
    after: "false",
  },
  {
    id: "kotlin-outside-roots-reconstruction",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin stale acceptance",
    before: 'mandatory.push("outside-module-roots");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "kotlin-script-omission-reconstruction",
    file: "review-kotlin-resolution.js",
    name: "context-kotlin stale acceptance",
    before: 'mandatory.push("script-loading-unknown");',
    after: 'mandatory.push("unselected-source");',
  },
  {
    id: "kotlin-grammar-identity-reconstruction",
    file: "review-behavior-validation.js",
    name: "context-kotlin stale acceptance",
    before: "analysis.grammarManifestDigest !== grammarManifestDigest",
    after: "false",
  },
  {
    id: "kotlin-declaration-default-capture",
    file: "review-polyglot.js",
    name: "context-kotlin broken acceptance",
    before: 'kind === "parameter" && node.nextSibling?.text === "="',
    after: 'false && node.nextSibling?.text === "="',
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
      "Original synthetic Kotlin captured-binding controls; no model inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
