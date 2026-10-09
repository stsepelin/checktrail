import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const controls = [
  {
    id: "python-bytecode-source-identity",
    file: "python-extension-runner.js",
    python: 'sys.pycache_prefix = str(pathlib.Path(temporary)/"bytecode")',
    after: "pass",
    test: "python-extensions.test.js",
    name: "native Python extension ignores stale timestamp bytecode and preserves existing caches",
  },
  {
    id: "python-receipt-binding",
    file: "python-extension-evidence.js",
    before: "JSON.stringify(report.manifest)!==JSON.stringify(manifest)",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-kind-binding",
    file: "python-extension-evidence.js",
    conditionPrefix: 'check.id!=="python."+manifest.kind||',
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-selected-native-pins",
    file: "python-extension-evidence.js",
    before:
      "JSON.stringify(manifest.toolPins)!==JSON.stringify(pythonExtensionPins)",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-input-stability",
    file: "python-extension-evidence.js",
    before: "!report.inputsStable",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-environment-identities",
    file: "python-extension-evidence.js",
    before:
      "JSON.stringify(report.environmentPackages)!==JSON.stringify(manifest.environmentPackages)",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-plugin-participation",
    file: "python-extension-evidence.js",
    call: "report.plugins.some",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-native-completion",
    file: "python-extension-evidence.js",
    before: "!report.complete",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions empty acceptance",
  },
  {
    id: "python-module-participation",
    file: "python-extension-evidence.js",
    conditionPrefix: "report.modules.length!==files.size||",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions empty acceptance",
  },
  {
    id: "python-dependency-count",
    file: "python-extension-evidence.js",
    before:
      "report.dependencyParticipation.length!==manifest.environmentPackages.length",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions empty acceptance",
  },
  {
    id: "python-dependency-origin",
    file: "python-extension-evidence.js",
    call: "participation.files.some",
    after: "false",
    test: "gate-python-extensions.test.js",
    name: "python-extensions empty acceptance",
  },
  {
    id: "python-preimport-input-bytes",
    file: "python-extension-runner.js",
    python:
      'if len(data)!=item["bytes"] or hashlib.sha256(data).hexdigest()!=item["sha256"]:',
    after: "if False:",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-native-api-bytes",
    file: "python-extension-runner.js",
    python:
      'if len(data)!=pin["bytes"] or hashlib.sha256(data).hexdigest()!=pin["sha256"]:',
    after: "if False:",
    test: "gate-python-extensions.test.js",
    name: "python-extensions prerequisite acceptance",
  },
  {
    id: "python-dependency-tree",
    file: "python-extension-runner.js",
    python: "if observed!=expected:",
    after: "if False:",
    test: "gate-python-extensions.test.js",
    name: "python-extensions stale acceptance",
  },
  {
    id: "python-postrun-input-bytes",
    file: "python-extension-runner.js",
    python: "    input_gate()\n    tool_gate()\n    inputs_stable=True",
    after: "    tool_gate()\n    inputs_stable=True",
    test: "python-extensions.test.js",
    name: "native Python extension rechecks excluded virtualenv bytes after successful pytest",
  },
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compact = (text) => text.replace(/\s+/g, "");
const pins = new Map(
  await Promise.all(
    [
      ...new Set([
        ...controls.map((c) => c.test),
        "python-extensions-fixture.js",
        "helpers.js",
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
      control.call &&
      ts.isCallExpression(node) &&
      compact(node.expression.getText(ast)) === control.call
    )
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
  let mutant;
  if (control.python) {
    assert.equal(
      original.split(control.python).length,
      2,
      "Exact Python mutation address: " + control.id,
    );
    mutant = original.replace(control.python, control.after);
  } else {
    assert.equal(matches.length, 1, "Exact mutation address: " + control.id);
    const target = matches[0];
    mutant =
      original.slice(0, target.getStart(ast)) +
      control.after +
      original.slice(target.end);
  }
  const js = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: mutant,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(
    js.status,
    0,
    "Mutation preflight: " + control.id + " " + js.stderr,
  );
  if (control.python) {
    const linked = mutant.replace(
      'from "./python-extension-pins.js";',
      "from " +
        JSON.stringify(
          new URL("../dist/src/python-extension-pins.js", import.meta.url).href,
        ) +
        ";",
    );
    assert.notEqual(linked, mutant);
    const url =
      "data:text/javascript;base64," + Buffer.from(linked).toString("base64");
    const evaluated = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const module=await import(" +
          JSON.stringify(url) +
          "); process.stdout.write(module.pythonExtensionRunner);",
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1048576 },
    );
    assert.equal(evaluated.status, 0, evaluated.stderr);
    const python = spawnSync(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        "import sys;compile(sys.stdin.read(),'<original-control>','exec')",
      ],
      { input: evaluated.stdout, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(
      python.status,
      0,
      "Python mutation preflight: " + control.id + " " + python.stderr,
    );
  }
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
          new URL("../dist/test/python-extensions-fixture.js", import.meta.url)
            .href,
        ),
      ),
      sourceSha256: digest(control.original),
      mutantSha256: digest(control.mutant),
      mutantOutputSha256: digest(mutant.stdout),
      mutantStderrSha256: digest(mutant.stderr),
      originalPassed: true,
      mutantCompiled: true,
      ...(control.python ? { pythonMutantCompiled: true } : {}),
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
      "Original synthetic native Python namespace, virtualenv, plugin and source-participation controls",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
