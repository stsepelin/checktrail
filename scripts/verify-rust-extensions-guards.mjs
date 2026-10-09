import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const controls = [
  {
    id: "rust-selected-artifact-sha256",
    file: "rust-toolchain-native.js",
    test: "rust-extensions.test.js",
    name: "native Rust workspace rechecks selected executable bytes after successful test witnesses",
    before: 'hash.digest("hex")!==pin.sha256',
    after: "false",
  },
  {
    id: "rust-post-witness-native-bytes",
    file: "rust-workspace-runner.js",
    test: "rust-extensions.test.js",
    name: "native Rust workspace rechecks selected executable bytes after successful test witnesses",
    before:
      "input.selection.nativeToolchain?await rustNativeToolchainMatches():null",
    after: "input.selection.nativeToolchain?true:null",
  },
  {
    id: "rust-check-kind",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before:
      '!["rust.cargo-check","rust.cargo-clippy","rust.cargo-test"].includes(check.id)',
  },
  {
    id: "rust-receipt-source",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "data.sourceFingerprint!==input.sourceFingerprint",
  },
  {
    id: "rust-input-stability",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "!data.inputsStable",
  },
  {
    id: "rust-selected-native-proof",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "data.nativeToolchainVerified!==true",
  },
  {
    id: "rust-artifact-features",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "!featuresMatch(events)",
  },
  {
    id: "rust-artifact-target",
    file: "rust-workspace-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "!targetArtifactsMatch(events)",
  },
  {
    id: "rust-fresh-artifacts",
    file: "rust-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "artifacts.some((item)=>item.fresh)",
  },
  {
    id: "rust-dep-info-count",
    file: "rust-evidence.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before: "!data.depInfoCount",
  },
  {
    id: "rust-preexecution-source",
    file: "rust-workspace-runner.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions stale acceptance",
    after: "false",
    before:
      "(await inventory(input.root)).fingerprint!==input.sourceFingerprint",
  },
  {
    id: "rust-postexecution-source",
    file: "rust-workspace-runner.js",
    test: "rust-extensions.test.js",
    name: "native Rust workspace rechecks source after successful runtime witnesses instead of certifying source changed by a test",
    after: "true",
    before:
      "(await inventory(input.root)).fingerprint===input.sourceFingerprint",
  },
  {
    id: "rust-native-bytes-and-path",
    file: "rust-toolchain-native.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions prerequisite acceptance",
    after: "{return true;}",
    function: "rustNativeToolchainMatches",
  },
  {
    id: "rust-live-native-output",
    file: "rust-workspace-runner.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions lifecycle acceptance",
    after: "true",
    before: "process.stderr.write(chunk)",
  },
  {
    id: "rust-owned-build-directory",
    file: "rust-workspace-runner.js",
    test: "gate-rust-extensions.test.js",
    name: "rust-extensions lifecycle acceptance",
    after: 'path.join("/tmp","checktrail-rust-workspace-")',
    before: 'path.join(temporaryBase,"checktrail-rust-workspace-")',
  },
];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compact = (text) => text.replace(/\s+/g, "");
const pins = new Map(
  await Promise.all(
    [
      ...new Set([
        ...controls.map((c) => c.test),
        "rust-extensions-fixture.js",
        "rust-workspace-fixture.js",
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
    if (
      control.before &&
      compact(node.getText(ast)) === compact(control.before)
    )
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
  assert.equal(matches.length, 1, "Exact mutation address: " + control.id);
  const target = matches[0];
  const mutant =
    original.slice(0, target.getStart(ast)) +
    control.after +
    original.slice(target.end);
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
      timeout: 180000,
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
          new URL("../dist/test/rust-extensions-fixture.js", import.meta.url)
            .href,
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
      "Original synthetic native Rust workspace, feature, target, source, byte identity and reached lifecycle controls",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
