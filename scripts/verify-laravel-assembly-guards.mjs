import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import ts from "typescript";
const repository = fileURLToPath(new URL("../", import.meta.url));
const main = new URL(
    "../dist/test/gate-assembly-laravel.test.js",
    import.meta.url,
  ),
  guards = new URL(
    "../dist/test/review-laravel-assembly-guards.test.js",
    import.meta.url,
  ),
  fixture = new URL(
    "../dist/test/review-laravel-assembly-fixture.js",
    import.meta.url,
  );
const processTests = new URL(
  "../dist/test/process-tree.test.js",
  import.meta.url,
);
const contract = new URL(
  "../dist/test/review-laravel-assembly-contract.js",
  import.meta.url,
);
const callbackFor = (name) =>
  name.startsWith("POSIX cleanup")
    ? processTests
    : name.endsWith("guard acceptance")
      ? guards
      : main;
const pins = new Map(
  await Promise.all(
    [main, guards, fixture, contract, processTests].map(async (file) => [
      file.href,
      await readFile(file),
    ]),
  ),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  {
    id: "receipt-source",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.runtime.sourceFingerprint !== args[offset + 2] ||",
    after: "false ||",
  },
  {
    id: "receipt-producer-name",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: 'result.runtime.producer.name !== "checktrail.laravel-runtime" ||',
    after: "false ||",
  },
  {
    id: "receipt-producer-version",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: 'result.runtime.producer.version !== "2.0.0" ||',
    after: "false ||",
  },
  {
    id: "receipt-assembly",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.runtime.assembly.name !== config.assembly ||",
    after: "false ||",
  },
  {
    id: "receipt-environment",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.runtime.assembly.environment !== config.environment ||",
    after: "false ||",
  },
  {
    id: "receipt-versions",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "canonical(result.versions) !== canonical(versions) ||",
    after: "false ||",
  },
  {
    id: "receipt-clock",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.clock !== config.clock ||",
    after: "false ||",
  },
  {
    id: "receipt-models",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "canonical(result.models) !== canonical(config.models) ||",
    after: "false ||",
  },
  {
    id: "receipt-count-vector",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before:
      "canonical(result.counts) !==\n                canonical(result.runtime.collections.map((c) => c.entries.length)) ||",
    after: "false ||",
  },
  {
    id: "receipt-total-count",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.entryCount !== result.counts.reduce((n, c) => n + c, 0) ||",
    after: "false ||",
  },
  {
    id: "receipt-request-count",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "result.requests.length !== config.requests.length",
    after: "false",
  },
  {
    id: "receipt-request-identity",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "canonical(received) !== canonical(identity) ||",
    after: "false ||",
  },
  {
    id: "receipt-response-evidence-bound",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel stale acceptance",
    before: "Buffer.byteLength(responseBody) > 65536",
    after: "false",
  },
  {
    id: "receipt-complete",
    file: "laravel-assembly-schema.js",
    name: "assembly-laravel stale acceptance",
    before: "!c.complete ||",
    after: "false ||",
  },
  {
    id: "receipt-order",
    file: "laravel-assembly-schema.js",
    name: "assembly-laravel stale acceptance",
    before: 'c.ordered !== (c.kind !== "bindings")',
    after: "false",
  },
  {
    id: "receipt-key",
    file: "laravel-assembly-schema.js",
    name: "assembly-laravel stale acceptance",
    before:
      'if ((c.kind === "routes" ? JSON.stringify(JSON.parse(e.key)) : e.key) !==\n                laravelAssemblyEntryKey(c.kind, e.attributes))',
    after: "if (false)",
  },
  {
    id: "declared-collections",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel broken acceptance",
    before: "if (normalize(c.entries) !== normalize(expected.entries))",
    after: "if (false)",
  },
  {
    id: "declared-responses",
    file: "laravel-assembly-evidence.js",
    name: "assembly-laravel broken acceptance",
    before:
      "if (status !== expected.status ||\n                responseBody !== expected.body ||\n                exceptionClass !== expected.exceptionClass)",
    after: "if (false)",
  },
  {
    id: "native-versions",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel prerequisite acceptance",
    before: "if(($versions[$name]??null)!==$version)",
    after: "if(false)",
  },
  {
    id: "native-selected-byte-validation",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel prerequisite acceptance",
    before:
      "filesize($file)!==$pin['bytes']||hash_file('sha256',$file)!==$pin['sha256']",
    after: "false",
  },
  {
    id: "native-byte-digest",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel prerequisite acceptance",
    before: "hash_file('sha256',$file)!==$pin['sha256']",
    after: "false",
  },
  {
    id: "native-model-defaults",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel fixed acceptance",
    before: "la_hash(rv_property($model,'with'))",
    after: "la_hash([])",
  },
  {
    id: "native-model-api",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel empty acceptance",
    before:
      "if((new ReflectionMethod($object,$method))->getDeclaringClass()->getName()!==$native)",
    after: "if(false)",
  },
  {
    id: "native-registration-lifetime",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel registration lifetime guard acceptance",
    before:
      "la_snapshot($app,$http,$router,$dispatcher,$schedule,$references,$config['models'])!==$snapshot",
    after: "false",
  },
  {
    id: "native-model-scope-lifetime",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel model scope lifetime guard acceptance",
    before: "$registrations['model:scopes:'.$class]=$scopes[$class]??[];",
    after: "$registrations['model:scopes:'.$class]=[];",
  },
  {
    id: "native-callback-identity",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel callback identity guard acceptance",
    before: "return ['object',$id,get_class($value)];",
    after: "return ['object',get_class($value)];",
  },
  {
    id: "native-clock-value",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel clock guard acceptance",
    before:
      "$now->format('U.u')!==$expected->format('U.u') || Illuminate\\Support\\Facades\\Date::now('UTC')->format('U.u')!==$expected->format('U.u')",
    after: "false",
  },
  {
    id: "native-clock-factory",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel clock guard acceptance",
    before: "if((new ReflectionProperty($factory,$key))->getValue()!==null)",
    after: "if(false)",
  },
  {
    id: "native-response-bound",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel response byte budget guard acceptance",
    before: "strlen($body)>65536",
    after: "false",
  },
  {
    id: "native-reserved-path",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel reserved path binding guard acceptance",
    before: "if(!is_string($actual)||$actual!==$native)",
    after: "if(false)",
  },
  {
    id: "native-kernel-api",
    file: "laravel-assembly-runner.js",
    name: "assembly-laravel native API guard acceptance",
    before:
      "if(get_class($http)!==Illuminate\\Foundation\\Http\\Kernel::class||get_class($console)!==Illuminate\\Foundation\\Console\\Kernel::class)",
    after: "if(false)",
  },
  {
    id: "planner-request-bytes",
    file: "laravel.js",
    name: "assembly-laravel planning bounds guard acceptance",
    before: 'Buffer.byteLength(request.body ?? "") > 32768 ||',
    after: "false ||",
  },
  {
    id: "planner-reserved-headers",
    file: "laravel.js",
    name: "assembly-laravel planning bounds guard acceptance",
    before: 'headers.some((h) => ["host", "content-length"].includes(h))',
    after: "false",
  },
  {
    id: "planner-duplicate-headers",
    file: "laravel.js",
    name: "assembly-laravel planning bounds guard acceptance",
    before: "new Set(headers).size !== headers.length ||",
    after: "false ||",
  },
  {
    id: "root-reaping-order",
    file: "process-tree.js",
    name: "POSIX cleanup stops a quiesced root after direct children are signalled and before requiring their reaping",
    before: "if (depth <= 1)\n            finishRoot();",
    after: "if (false)\n            finishRoot();",
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
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stdout + result.stderr);
  return result;
}

const selected = new Set(process.argv.slice(2));
assert.ok(
  [...selected].every((id) => controls.some((c) => c.id === id)),
  "Unknown guard control",
);
const prepared = [];
// Resolve and compile every selected mutation before changing any target.
for (const c of controls.filter((c) => !selected.size || selected.has(c.id))) {
  const file = new URL("../dist/src/" + c.file, import.meta.url),
    original = await readFile(file, "utf8");
  assert.equal(
    original.split(c.before).length,
    2,
    "Exact mutation address: " + c.id,
  );
  const mutant = original.replace(c.before, c.after);
  const parsed = ts.createSourceFile(
    c.file,
    mutant,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    parsed.parseDiagnostics.length,
    0,
    "Compiling mutation preflight: " + c.id,
  );
  prepared.push({ ...c, file, original, mutant });
}
const baselines = new Set(),
  evidence = [];
async function verifyPins() {
  for (const [url, bytes] of pins)
    assert.deepEqual(
      await readFile(new URL(url)),
      bytes,
      "Original callback/fixture changed",
    );
}
for (const c of prepared) {
  await verifyPins();
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Source changed before mutation",
  );
  if (!baselines.has(c.name)) {
    const baseline = run(c.name);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    baselines.add(c.name);
  }
  try {
    await writeFile(c.file, c.mutant);
    const syntax = spawnSync(
      process.execPath,
      ["--check", fileURLToPath(c.file)],
      { encoding: "utf8" },
    );
    assert.equal(syntax.status, 0, syntax.stdout + syntax.stderr);
    if (c.file.pathname.endsWith("/laravel-assembly-runner.js")) {
      const emitted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import{laravelAssemblyRunner,laravelAssemblyVersionRunner}from ${JSON.stringify(c.file.href)};console.log(JSON.stringify([laravelAssemblyRunner,laravelAssemblyVersionRunner]));`,
        ],
        { cwd: repository, encoding: "utf8" },
      );
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const php of JSON.parse(emitted.stdout)) {
        const compiled = spawnSync("php", ["-l"], {
          input: "<?php\n" + php,
          encoding: "utf8",
        });
        assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      }
    }
    const killed = run(c.name);
    assert.equal(
      killed.status,
      1,
      "Original assertion must kill " +
        c.id +
        "\n" +
        killed.stdout +
        killed.stderr,
    );
    assert.match(killed.stdout, /ERR_ASSERTION/, c.id);
    assert.doesNotMatch(
      killed.stdout + killed.stderr,
      /SyntaxError|TypeError|ReferenceError/,
    );
    assert.ok(killed.stdout.includes("not ok 1 - " + c.name));
    await verifyPins();
    evidence.push({
      id: c.id,
      callback: c.name,
      callbackSha256: digest(pins.get(callbackFor(c.name).href)),
      fixtureSha256: digest(pins.get(fixture.href)),
      sourceSha256: digest(c.original),
      mutantSha256: digest(c.mutant),
      originalPassed: true,
      mutantCompiled: true,
      mutantFailedAssertion: true,
    });
  } finally {
    await writeFile(c.file, c.original);
  }
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Mutation source restoration",
  );
}
for (const name of baselines) {
  const restored = run(name);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  for (const c of evidence.filter((c) => c.callback === name))
    c.restoredPassed = true;
}
await verifyPins();
for (const c of prepared)
  assert.equal(
    await readFile(c.file, "utf8"),
    c.original,
    "Final source restoration",
  );
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic Laravel assembly controls; selected byte-pinned native runtime; no inference or field evaluation",
    controls: evidence,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
