import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const controls = [
  {
    id: "eslint-processor-location",
    file: "eslint-evidence.js",
    before: "!file.processorUsed&&message.line",
    after: "message.line",
    test: "eslint-participation.test.js",
    name: "native processor diagnostics preserve messages without inventing physical source coordinates",
  },
  {
    id: "eslint-effective-leaf-rules",
    file: "eslint-participation.js",
    before: "event.activeRules===0",
    after: "false",
    test: "eslint-participation.test.js",
    name: "native ESLint virtual leaves require their effective rules and permit an unruled processor container",
  },
  {
    id: "eslint-source-binding",
    file: "eslint-evidence.js",
    before: "evidence.sourceFingerprint!==manifest.sourceFingerprint",
    after: "false",
    test: "eslint-participation.test.js",
    name: "native ESLint participation reaches the TypeScript parser for named blocks and binds every planned source",
  },
  {
    id: "eslint-configuration-binding",
    file: "eslint-evidence.js",
    before:
      "JSON.stringify(evidence.configuration)!==JSON.stringify(manifest.configuration)",
    after: "false",
    test: "eslint-participation.test.js",
    name: "native ESLint participation reaches the TypeScript parser for named blocks and binds every planned source",
  },
  {
    id: "eslint-native-api-pins",
    file: "eslint-participation-prerequisites.js",
    before:
      'bytes.length!==pin.bytes||createHash("sha256").update(bytes).digest("hex")!==pin.sha256',
    after: "false",
    test: "eslint-participation.test.js",
    name: "native ESLint participation checks selected runtime bytes before importing configuration",
  },
  {
    id: "eslint-complete-block-graph",
    file: "eslint-participation.js",
    function: "completeESLintParticipation",
    after: "{return true;}",
    test: "eslint-participation.test.js",
    name: "native ESLint participation reconciles identity and repeated blocks and refuses an empty processor",
  },
  {
    id: "eslint-language-receiver",
    file: "eslint-participation-runtime.js",
    before: "value.bind(target)",
    after: "value.bind({})",
    test: "eslint-participation.test.js",
    name: "native ESLint participation preserves private language receiver state and native rule callbacks",
  },
  {
    id: "loader-hook-bytes",
    file: "node-loader-runner.js",
    before: "(awaitresolve(loader.path)).identity.sha256!==loader.sha256",
    after: "false",
    test: "node-loaders.test.js",
    name: "native loader re-verifies planned hooks and tests before launching any selected test",
  },
  {
    id: "loader-test-bytes",
    file: "node-loader-runner.js",
    before: "observed.sha256!==file.sha256||observed.bytes!==file.bytes",
    after: "false",
    test: "node-loaders.test.js",
    name: "native loader re-verifies planned hooks and tests before launching any selected test",
  },
  {
    id: "loader-completion-boundary",
    file: "node-loader-evidence.js",
    conditionPrefix: "markers.length!==2||",
    after: "false",
    test: "node-loaders.test.js",
    name: "declared ESM and CJS native loaders reach each typed test and preserve assertion failures",
  },
  {
    id: "loader-receipt-binding",
    file: "node-loader-evidence.js",
    before:
      "JSON.stringify(nodeLoaderManifestSchema.parse(marker.manifest))!==JSON.stringify(selected.data)",
    after: "false",
    test: "node-loaders.test.js",
    name: "declared ESM and CJS native loaders reach each typed test and preserve assertion failures",
  },
  {
    id: "loader-exact-file-summary",
    file: "node-loader-evidence.js",
    conditionPrefix: "summaries.length!==expected.length||",
    after: "false",
    test: "node-loaders.test.js",
    name: "declared ESM and CJS native loaders reach each typed test and preserve assertion failures",
  },
  {
    id: "library-receipt-binding",
    file: "vite-library-evidence.js",
    before: "JSON.stringify(receipt.manifest)!==JSON.stringify(manifest)",
    after: "false",
    test: "vite-library.test.js",
    name: "native library refuses forged declaration, format, export, module and consumer accounting",
  },
  {
    id: "library-completeness",
    file: "vite-library-evidence.js",
    conditionPrefix: "process.exitCode!==0||",
    after: "false",
    test: "vite-library.test.js",
    name: "native library emits both formats and fresh declarations and detects producer and downstream defects",
  },
  {
    id: "library-native-api-pins",
    file: "vite-library-prerequisites.js",
    before:
      'bytes.length!==pin.bytes||createHash("sha256").update(bytes).digest("hex")!==pin.sha256',
    loop: true,
    after: "false",
    test: "vite-library.test.js",
    name: "native library planning imports no tool and changed selected API bytes remain unavailable",
  },
  {
    id: "library-type-checking",
    file: "vite-library-runner.js",
    before: "noCheck:false",
    after: "noCheck:true",
    test: "vite-library.test.js",
    name: "native library emits both formats and fresh declarations and detects producer and downstream defects",
  },
  {
    id: "library-fresh-declaration-resolution",
    file: "vite-library-runner.js",
    conditionalPrefix: "memory.has(declarationEntry)?",
    after: "undefined",
    test: "vite-library.test.js",
    name: "native library emits both formats and fresh declarations and detects producer and downstream defects",
  },
  {
    id: "library-both-native-formats",
    file: "vite-library-runner.js",
    before: '["es","cjs"]',
    after: '["es"]',
    test: "vite-library.test.js",
    name: "native library emits both formats and fresh declarations and detects producer and downstream defects",
  },
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compact = (text) => text.replace(/\s+/g, "");
const pins = new Map(
  await Promise.all(
    [
      ...new Set([
        ...controls.map((c) => c.test),
        "javascript-extensions-fixture.js",
        "helpers.js",
        "tool-fixture.js",
      ]),
    ].map(async (name) => {
      const file = new URL("../dist/test/" + name, import.meta.url);
      return [file.href, await readFile(file)];
    }),
  ),
);
const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((c) => c.id === id)),
  "Unknown control",
);
const prepared = [];
for (const control of controls.filter(
  (c) => !selected.size || selected.has(c.id),
)) {
  const file = new URL("../dist/src/" + control.file, import.meta.url);
  const original = await readFile(file, "utf8");
  const ast = ts.createSourceFile(
    control.file,
    original,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches = [];
  function visit(node) {
    let target;
    if (
      control.function &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === control.function
    )
      target = node.body;
    if (control.before && compact(node.getText(ast)) === control.before)
      target = node;
    if (
      control.conditionPrefix &&
      ts.isIfStatement(node) &&
      compact(node.expression.getText(ast)).startsWith(control.conditionPrefix)
    )
      target = node.expression;
    if (
      control.conditionalPrefix &&
      ts.isConditionalExpression(node) &&
      compact(node.getText(ast)).startsWith(control.conditionalPrefix)
    )
      target = node;
    if (target && control.loop !== undefined) {
      let parent = node.parent;
      let loop = false;
      while (parent) {
        if (ts.isForOfStatement(parent)) loop = true;
        parent = parent.parent;
      }
      if (loop !== control.loop) target = undefined;
    }
    if (target) matches.push(target);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, "Exact mutation address: " + control.id);
  const target = matches[0];
  const mutant =
    original.slice(0, target.getStart(ast)) +
    control.after +
    original.slice(target.end);
  const parsed = ts.createSourceFile(
    control.file,
    mutant,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    parsed.parseDiagnostics.length,
    0,
    "Mutation preflight: " + control.id,
  );
  prepared.push({ ...control, file, original, mutant });
}
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
const run = (control) =>
  spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern",
      "^" + control.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      fileURLToPath(new URL("../dist/test/" + control.test, import.meta.url)),
    ],
    {
      env: environment,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 2 * 1048576,
    },
  );
async function verifyPins() {
  for (const [url, bytes] of pins)
    assert.deepEqual(
      await readFile(new URL(url)),
      bytes,
      "Original callback/fixture changed",
    );
}
const baselines = new Map();
const evidence = [];
for (const control of prepared) {
  await verifyPins();
  assert.equal(await readFile(control.file, "utf8"), control.original);
  if (!baselines.has(control.name)) {
    const original = run(control);
    assert.equal(original.status, 0, original.stdout + original.stderr);
    assert.match(original.stdout, /# pass 1\n/);
    baselines.set(control.name, control);
  }
  let mutant;
  try {
    await writeFile(control.file, control.mutant);
    const syntax = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(control.file)],
      { encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    mutant = run(control);
    assert.equal(mutant.error, undefined);
    assert.equal(mutant.signal, null);
    assert.notEqual(mutant.status, 0, "Control survived: " + control.id);
    assert.match(
      mutant.stdout,
      /code: 'ERR_ASSERTION'/,
      "Original assertion must kill mutation: " + control.id,
    );
    assert.match(mutant.stdout, /# fail 1\n/);
    evidence.push({
      id: control.id,
      callback: control.name,
      callbackSha256: digest(
        pins.get(new URL("../dist/test/" + control.test, import.meta.url).href),
      ),
      fixtureSha256: digest(
        pins.get(
          new URL(
            "../dist/test/javascript-extensions-fixture.js",
            import.meta.url,
          ).href,
        ),
      ),
      sourceSha256: digest(control.original),
      mutantSha256: digest(control.mutant),
      mutantOutputSha256: digest(mutant.stdout),
      mutantStderrSha256: digest(mutant.stderr),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(control.file, control.original);
  }
  assert.equal(await readFile(control.file, "utf8"), control.original);
}
for (const [name, control] of baselines) {
  const restored = run(control);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  for (const row of evidence.filter((c) => c.callback === name))
    row.restoredPassed = true;
}
await verifyPins();
for (const control of prepared)
  assert.equal(await readFile(control.file, "utf8"), control.original);
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic native JavaScript source, loader, library and declaration controls",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
