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
    id: "php-kind-binding",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    before: 'check.id!=="php.extensions"',
  },
  {
    id: "php-receipt-binding",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    before: "canonical(result.manifest)!==canonical(manifest)",
  },
  {
    id: "php-selected-native-pins",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    before: "canonical(manifest.toolPins)!==canonical(phpExtensionToolPins)",
  },
  {
    id: "php-extension-runtime",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    before: "canonical(result.runtime)!==canonical(phpExtensionRuntime)",
  },
  {
    id: "php-input-stability",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    before: "!result.inputsStable",
  },
  {
    id: "php-class-source-binding",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    call: "result.classes.some",
  },
  {
    id: "php-native-completion",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions empty acceptance",
    after: "false",
    before: "!result.complete",
  },
  {
    id: "php-probe-count",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions empty acceptance",
    after: "false",
    before: "model.probes.length!==spec.probes.length",
  },
  {
    id: "php-probe-source-input-binding",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
    after: "false",
    conditionPrefix: "probe.attribute!==expected.attribute||",
  },
  {
    id: "php-native-default-comparison",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions near-miss acceptance",
    after: "false",
    before: "canonical(model.defaults)!==canonical(spec.defaults)",
  },
  {
    id: "php-native-accessor-comparison",
    file: "php-extension-evidence.js",
    test: "gate-php-extensions.test.js",
    name: "php-extensions broken acceptance",
    after: "false",
    before: "canonical(probe.value)!==canonical(expected.expected)",
  },
  {
    id: "php-preimport-source-bytes",
    file: "php-extension-runner.js",
    php: "if(filesize($file)!==$binding['bytes']||hash_file('sha256',$file)!==$binding['sha256'])",
    after: "if(false)",
    test: "gate-php-extensions.test.js",
    name: "php-extensions stale acceptance",
  },
  {
    id: "php-preimport-tool-bytes",
    file: "php-extension-runner.js",
    php: "if(($versions[$pin['package']]??null)!==$pin['version']||filesize($file)!==$pin['bytes']||hash_file('sha256',$file)!==$pin['sha256'])",
    after: "if(false)",
    test: "gate-php-extensions.test.js",
    name: "php-extensions prerequisite acceptance",
  },
  {
    id: "php-preimport-extension-closure",
    file: "php-extension-runner.js",
    php: "if(pe_canonical($runtime)!==pe_canonical($prepared['runtime'])||array_column($runtime['extensions'],'name')!==$manifest['config']['nativeExtensions'])",
    after: "if(false)",
    test: "gate-php-extensions.test.js",
    name: "php-extensions prerequisite acceptance",
  },
  {
    id: "php-post-witness-source-bytes",
    file: "php-extension-runner.js",
    php: "try{pe_inputs($manifest);pe_tools($manifest",
    after: "try{pe_tools($manifest",
    test: "php-extensions.test.js",
    name: "native PHP extension rechecks excluded generated source after successful accessor witnesses",
  },
  {
    id: "php-recursive-scalar-types",
    file: "php-extension-runner.js",
    php: "$type=get_debug_type($value);",
    after: "$type=get_debug_type($value);if($type==='float')$type='int';",
    test: "php-extensions.test.js",
    name: "native PHP accessor array witnesses preserve nested scalar types instead of borrowing JSON number equality",
  },
  {
    id: "php-observed-accessor-values",
    file: "php-extension-runner.js",
    php: "$value=pe_value($copy->getAttribute($key));",
    after: "$value=pe_value('unobserved');",
    test: "gate-php-extensions.test.js",
    name: "php-extensions fixed acceptance",
  },
];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compact = (text) => text.replace(/\s+/g, "");
const pins = new Map(
  await Promise.all(
    [
      ...new Set([
        ...controls.map((c) => c.test),
        "php-extensions-fixture.js",
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
  if (control.php) {
    assert.equal(
      original.split(control.php).length,
      2,
      "Exact PHP mutation address: " + control.id,
    );
    mutant = original.replace(control.php, control.after);
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
  if (control.php) {
    const linked = mutant.replace(
      'from "./php-extension-pins.js";',
      "from " +
        JSON.stringify(
          new URL("../dist/src/php-extension-pins.js", import.meta.url).href,
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
          "); process.stdout.write(module.phpExtensionRunner);",
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1048576 },
    );
    assert.equal(evaluated.status, 0, evaluated.stderr);
    const php = spawnSync("php", ["-n", "-l"], {
      input: "<?php\n" + evaluated.stdout,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(
      php.status,
      0,
      "PHP mutation preflight: " + control.id + " " + php.stdout + php.stderr,
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
          new URL("../dist/test/php-extensions-fixture.js", import.meta.url)
            .href,
        ),
      ),
      sourceSha256: digest(control.original),
      mutantSha256: digest(control.mutant),
      mutantOutputSha256: digest(mutant.stdout),
      mutantStderrSha256: digest(mutant.stderr),
      originalPassed: true,
      mutantCompiled: true,
      ...(control.php ? { phpMutantCompiled: true } : {}),
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
      "Original synthetic native PHP extension, generated proxy, defaults and accessor controls",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
