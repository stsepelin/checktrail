import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callback = new URL(
    "../dist/test/gate-swift-extensions.test.js",
    import.meta.url,
  ),
  before = await readFile(callback),
  fixture = new URL(
    "../dist/test/swift-extensions-fixture.js",
    import.meta.url,
  ),
  fixtureBefore = await readFile(fixture),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const fullDefinitions = [
  {
    id: "cancelled-retained-packet",
    name: "empty",
    file: "swift-extensions-evidence.js",
    from: "process.cancelled",
    to: "false",
  },
  {
    id: "current-physical-input-bytes",
    name: "stale",
    file: "swift-extensions-freshness.js",
    from: "mavenHash(read(path.join(directory, pin.path))) === pin.sha256",
    to: "true",
  },
  {
    id: "complete-current-input-tree",
    name: "stale",
    file: "swift-extensions-freshness.js",
    from: "swiftSame(files, invocation.inputs.map((p) => p.path))",
    to: "true",
  },
  {
    id: "physical-compiler-role-cohort",
    name: "empty",
    file: "swift-extensions-native.js",
    from: "swiftSame([...counts.keys()], expected)",
    to: "true",
  },
  {
    id: "native-header-mapping-denominator",
    name: "empty",
    file: "swift-extensions-sdk.js",
    from: "mappings.size === expectedMappings.size",
    to: "true",
  },
  {
    id: "native-testing-macro-cohort",
    name: "empty",
    file: "swift-extensions-sdk.js",
    from: 'macroBindings.has(JSON.stringify([\n                macro,\n                "/usr/lib/swift/host/plugins/lib" + macro + ".so",\n                "",\n            ]))',
    to: "true",
  },
  {
    id: "complete-declared-implicit-products",
    name: "empty",
    file: "swift-extensions-graph.js",
    from: "swiftSame(products.map((v) => v.name), expected.map((v) => v.name))",
    to: "true",
  },
  {
    id: "xctest-discovery-denominator",
    name: "empty",
    file: "swift-xctest.js",
    from: "swiftSame(ids, listed)",
    to: "true",
  },
  {
    id: "native-tool-after-bytes",
    name: "stale",
    file: "swift-extensions-evidence.js",
    from: "t.sha256 === t.afterSha256",
    to: "true",
  },
  {
    id: "native-sdk-after-bytes",
    name: "stale",
    file: "swift-extensions-evidence.js",
    from: "packet.sdkBeforeSha256 === packet.sdkAfterSha256",
    to: "true",
  },
  {
    id: "complete-generated-after-tree",
    name: "empty",
    file: "swift-extensions-evidence.js",
    from: "swiftSame(packet.generatedAfter, packet.generatedBefore)",
    to: "true",
  },
  {
    id: "pinned-sdk-before-project-dsl",
    name: "prerequisite",
    file: "swift-extensions-physical.js",
    from: "mavenHash(bytes) === pin.sha256",
    to: "true",
  },
  {
    id: "native-xctest-selection",
    name: "near-miss",
    file: "swift-extensions-runner.js",
    nativeInvocation: true,
    mode: "xctest",
    cases: 2,
    from: '["--no-parallel"]',
    to: '["--no-parallel", "--skip", "OriginalQuantityXCTests/testAdjacentValue"]',
  },
  {
    id: "native-testing-selection",
    name: "near-miss",
    file: "swift-extensions-runner.js",
    nativeInvocation: true,
    mode: "testing",
    cases: 2,
    from: 'path.join(temporary, "events.jsonl"),',
    to: 'path.join(temporary, "events.jsonl"), "--skip", "originalTestingParameterized",',
  },
  {
    id: "native-compiler-declaration-mode",
    name: "near-miss",
    file: "swift-native.js",
    nativeInvocation: true,
    mode: "xctest",
    cases: 3,
    from: '"-dump-ast"',
    to: '"-dump-parse"',
  },
];
const shard = process.argv[2] ?? "all";
assert.ok(["all", "1", "2", "3"].includes(shard));
const definitions = fullDefinitions.filter(
  (_, i) => shard === "all" || i % 3 === Number(shard) - 1,
);
const originals = new Map();
for (const control of definitions) {
  const url = new URL("../dist/src/" + control.file, import.meta.url);
  if (!originals.has(control.file))
    originals.set(control.file, await readFile(url, "utf8"));
  const original = originals.get(control.file);
  if (control.pattern) {
    const matches = [...original.matchAll(new RegExp(control.pattern, "g"))];
    assert.equal(matches.length, 1, control.id);
    control.from = matches[0][0];
  }
  assert.equal(original.split(control.from).length, 2, control.id);
}
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const invoke = (args) =>
  spawnSync(process.execPath, args, {
    cwd: repository,
    env,
    encoding: "utf8",
    timeout: 1170000,
    maxBuffer: 4 * 1048576,
  });
const run = (name) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "--test-name-pattern=^swift-extensions " + name + " acceptance$",
    fileURLToPath(callback),
  ]);
const complete = (r) => {
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-1000));
  assert.match(r.stdout, /^# pass 1$/m);
  assert.match(r.stdout, /^# skipped 0$/m);
};
const results = [];
const baselines = new Set();
for (const control of definitions) {
  process.stderr.write(
    JSON.stringify({ control: control.id, callback: control.name }) + "\n",
  );
  const url = new URL("../dist/src/" + control.file, import.meta.url),
    original = originals.get(control.file),
    mutant = original.replace(control.from, control.to);
  // Every control restores the exact original bytes. A successful baseline for
  // the same callback/source identity can be reused; each mutant and restored
  // callback still executes in its own fresh native process and fixture.
  if (!baselines.has(control.name)) {
    complete(run(control.name));
    baselines.add(control.name);
  }
  let nativeCompiled = false;
  try {
    await writeFile(url, mutant);
    const checked = invoke(["--check", fileURLToPath(url)]);
    assert.equal(checked.status, 0, checked.stderr);
    if (control.nativeInvocation) {
      const proof = invoke([
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';import {swiftExtensionsFixture} from './dist/test/swift-extensions-fixture.js';import {validate} from './dist/src/engine.js';import {swiftExtensionsPacketSchema,swiftExtensionsCompiled} from './dist/src/swift-extensions-native.js';
const cleanup=[];try{const {root}=await swiftExtensionsFixture({after:f=>cleanup.push(f)},${JSON.stringify(control.mode)});const report=await validate(root,{trusted:true,timeoutMs:120000});const reached=report.checks[0].processes[0];assert.equal(reached.exitCode,0,reached.stderr.slice(-1500));const packet=swiftExtensionsPacketSchema.parse(JSON.parse(reached.stdout));const build=packet.receipts.find(r=>r.phase==='build');assert.equal(build.exitCode,0);swiftExtensionsCompiled(packet.config,packet.workspace,packet.temporary,packet.tools.find(t=>t.name==='swift-frontend').entry,build.stdout+'\\n'+build.stderr);const test=packet.receipts.find(r=>r.phase==='test');assert.equal(test.exitCode,0);let bodies;if(packet.mode==='xctest'){bodies=test.stdout.split('\\n').filter(l=>l.startsWith("Test Case '")&&l.includes("' passed (")).length;}else{const events=packet.artifacts.find(a=>a.path==='events.jsonl').text.trimEnd().split('\\n').map(l=>JSON.parse(l));bodies=events.filter(e=>e.kind==='event'&&e.payload.kind==='testEnded').length;}assert.equal(bodies,${control.cases});${control.id === "native-compiler-declaration-mode" ? "assert.ok(packet.receipts.filter(r=>r.phase.startsWith('ast:')).every(r=>r.exitCode===0&&r.args.includes('-dump-parse')));" : "assert.ok(test.args.includes('--skip'));"}console.log(JSON.stringify({nativeCompilerCohortReached:true,nativeTestBodyReached:true,executedBodies:bodies}));}finally{for(const f of cleanup)await f();}`,
      ]);
      assert.equal(proof.error, undefined);
      assert.equal(proof.status, 0, proof.stderr.slice(-2000));
      assert.equal(JSON.parse(proof.stdout).nativeTestBodyReached, true);
      nativeCompiled = true;
    }
    const failed = run(control.name);
    assert.equal(failed.error, undefined);
    assert.equal(failed.signal, null);
    assert.equal(
      failed.status,
      1,
      control.id + ": " + failed.stdout.slice(-3000),
    );
    assert.match(failed.stdout, /code: 'ERR_ASSERTION'/);
    assert.match(failed.stdout, /^# fail 1$/m);
    assert.match(failed.stdout, /^# skipped 0$/m);
  } finally {
    await writeFile(url, original);
  }
  complete(run(control.name));
  assert.equal(await readFile(url, "utf8"), original);
  results.push({
    id: control.id,
    callback: "swift-extensions " + control.name + " acceptance",
    expressionsReplaced: 1,
    originalPassed: true,
    originalBaselineReusedForIdenticalBytes: true,
    mutantJavaScriptSyntaxChecked: true,
    ...(control.nativeInvocation
      ? {
          mutatedNativeInvocationCompilerCohortReached: nativeCompiled,
          nativeTestBodiesReachedUnderMutatedInvocation: nativeCompiled,
          expectedExecutedBodies: control.cases,
        }
      : {}),
    mutantFailedAssertion: true,
    restoredPassed: true,
    originalSha256: hash(original),
    mutantSha256: hash(mutant),
  });
}
assert.deepEqual(await readFile(callback), before);
assert.deepEqual(await readFile(fixture), fixtureBefore);
for (const [file, original] of originals)
  assert.equal(
    await readFile(new URL("../dist/src/" + file, import.meta.url), "utf8"),
    original,
  );
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "swift-extensions",
    shard,
    fullControlInventory: fullDefinitions.map((c) => c.id),
    controls: results,
    distinctOriginalBaselineCallbacks: [...baselines],
    mutantAndRestoredProcessesPerControl: 2,
    callbacks: [
      {
        file: "gate-swift-extensions.test.js",
        sha256: hash(before),
      },
    ],
    fixtures: [
      {
        file: "swift-extensions-fixture.js",
        sha256: hash(fixtureBefore),
      },
    ],
    fixturesUnchanged: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeSwiftExecutionReached: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
