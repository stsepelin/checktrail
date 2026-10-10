import console from "node:console";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const evidenceFile = "jvm-wrapper-evidence-controls.test.js",
  nativeFile = "jvm-wrappers.test.js";
const messages = {
  "wrapper-identity": "Native wrapper source and derived offline properties",
  "generator-accounting": "Every declared native generator",
  "generator-input": "Generator input identity",
  "generated-output-accounting": "Every fresh generated Java output",
  "generated-class-contract": "Generated output class contract",
  "physical-class-accounting": "Every physical generated class",
  "physical-class-origin": "Native generated class and source-file origins",
  "module-accounting": "Every declared native JPMS descriptor",
  "module-contract": "Native JPMS name, requires and exports",
  "owned-distribution": "Owned selected wrapper distribution",
};
const controls = Object.entries(messages).map(([id, message]) => ({
  id,
  message,
  file: "jvm-extension-evidence.js",
  test: evidenceFile,
  name: "actual JVM wrapper receipt rejects " + id,
}));
controls.push(
  {
    id: "maven-compiler-inputs",
    message: "Fresh compiler input accounting",
    file: "maven-evidence.js",
    test: evidenceFile,
    name: "actual JVM wrapper receipt rejects maven-compiler-inputs",
  },
  {
    id: "gradle-source-inputs",
    message: "Complete selected native source set",
    file: "gradle-evidence.js",
    test: evidenceFile,
    name: "actual JVM wrapper receipt rejects gradle-source-inputs",
  },
  {
    id: "gradle-launcher-ancestry",
    message: "Native build runs beneath the owned launcher",
    file: "gradle-evidence.js",
    test: evidenceFile,
    name: "actual JVM wrapper receipt rejects gradle-launcher-ancestry",
  },
  {
    id: "selected-native-digest",
    before: 'hash.digest("hex")!==pin.sha256',
    file: "jvm-extensions.js",
    test: nativeFile,
    name: "selected JVM artifacts reject both size changes and same-size digest changes",
  },
  {
    id: "live-native-output",
    before: "process.stderr.write(chunk)",
    file: "jvm-invoke.js",
    test: nativeFile,
    name: "actual JVM invoker mirrors live output before a native child terminates",
  },
);
for (const kind of ["maven", "gradle"]) {
  controls.push(
    {
      id: kind + "-post-wrapper-bytes",
      lastCall: "verifyJvmWrapper",
      file: kind + "-runner.js",
      test: nativeFile,
      name: "native JVM wrappers recheck original excluded archives after successful tests",
    },
    {
      id: kind + "-post-distribution-bytes",
      lastCall: "verifyMavenTree",
      argumentPrefix: "distribution,",
      file: kind + "-runner.js",
      test: nativeFile,
      name: "native JVM wrappers recheck bootstrap-produced distributions after successful tests",
    },
    {
      id: kind + "-post-generated-source",
      before:
        "mavenHash(await readFile(path.join(workspace, output.path))) !== output.sha256",
      file: kind + "-runner.js",
      test: nativeFile,
      name: "native JVM generated source bytes remain bound after successful class and test witnesses",
    },
  );
}
const compact = (text) => text.replace(/\s+/g, "");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((c) => c.id === id)),
  "Unknown JVM guard control",
);
const pins = new Map(
  await Promise.all(
    [
      evidenceFile,
      nativeFile,
      "jvm-wrappers-fixture.js",
      "maven-fixture.js",
      "gradle-fixture.js",
      "helpers.js",
    ].map(async (name) => {
      const url = new URL("../dist/test/" + name, import.meta.url);
      return [url.href, await readFile(url)];
    }),
  ),
);
const prepared = [];
for (const control of controls.filter(
  (c) => !selected.size || selected.has(c.id),
)) {
  const file = new URL("../dist/src/" + control.file, import.meta.url),
    original = await readFile(file, "utf8"),
    source = ts.createSourceFile(
      control.file,
      original,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    targets = [];
  function visit(node) {
    if (
      control.message &&
      ts.isCallExpression(node) &&
      node.arguments.length === 2 &&
      ts.isStringLiteral(node.arguments[1]) &&
      node.arguments[1].text === control.message
    )
      targets.push(node.arguments[0]);
    else if (
      control.lastCall &&
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === control.lastCall &&
      (!control.argumentPrefix ||
        compact(
          node.expression.arguments.map((a) => a.getText(source)).join(","),
        ).startsWith(control.argumentPrefix))
    )
      targets.push(node);
    else if (
      control.before &&
      compact(node.getText(source)) === compact(control.before)
    )
      targets.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (control.lastCall) {
    assert.ok(
      targets.length >= 2,
      "Distinct pre/post addresses: " + control.id,
    );
    targets.splice(0, targets.length - 1);
  }
  assert.equal(targets.length, 1, "Exact guard address: " + control.id);
  const target = targets[0],
    replacement = control.lastCall
      ? "undefined"
      : control.before?.includes("hash.digest") ||
          control.before?.includes("mavenHash")
        ? "false"
        : "true";
  const mutant =
    original.slice(0, target.getStart(source)) +
    replacement +
    original.slice(target.end);
  assert.equal(
    ts.createSourceFile(
      control.file,
      mutant,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ).parseDiagnostics.length,
    0,
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
      "^" + control.name + "$",
      fileURLToPath(new URL("../dist/test/" + control.test, import.meta.url)),
    ],
    {
      env: environment,
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 2 * 1048576,
    },
  );
async function verifyPins() {
  for (const [url, bytes] of pins)
    assert.deepEqual(
      await readFile(new URL(url)),
      bytes,
      "Original native callback changed",
    );
}
const baselines = new Map(),
  evidence = [];
for (const control of prepared) {
  await verifyPins();
  assert.equal(await readFile(control.file, "utf8"), control.original);
  if (!baselines.has(control.name)) {
    const original = run(control);
    assert.equal(original.status, 0, original.stdout + original.stderr);
    assert.match(original.stdout, /# pass 1\n/);
    assert.match(original.stdout, /# skipped 0\n/);
    baselines.set(control.name, control);
  }
  try {
    await writeFile(control.file, control.mutant);
    const syntax = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(control.file)],
      { encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    const mutant = run(control);
    assert.equal(mutant.error, undefined);
    assert.equal(mutant.signal, null);
    assert.notEqual(
      mutant.status,
      0,
      "JVM guard control survived: " + control.id,
    );
    assert.match(
      mutant.stdout,
      /code: 'ERR_ASSERTION'/,
      "Named native assertion must reject this compiled control: " + control.id,
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
          new URL("../dist/test/jvm-wrappers-fixture.js", import.meta.url).href,
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
}
for (const [name, control] of baselines) {
  const restored = run(control);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.match(restored.stdout, /# pass 1\n/);
  for (const row of evidence.filter((c) => c.callback === name))
    row.restoredPassed = true;
}
await verifyPins();
for (const control of prepared)
  assert.equal(await readFile(control.file, "utf8"), control.original);
console.log(
  JSON.stringify({
    controls: evidence,
    nativeReceiptControlsUseActualSourceExecution: true,
    eachControlUsesFreshChildProcess: true,
    wholeQualityAssessed: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }),
);
