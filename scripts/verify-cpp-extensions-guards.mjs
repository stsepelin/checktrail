import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callback = new URL(
    "../dist/test/gate-cpp-extensions.test.js",
    import.meta.url,
  ),
  before = await readFile(callback),
  fixture = new URL("../dist/test/cpp-extensions-fixture.js", import.meta.url),
  fixtureBefore = await readFile(fixture),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const fullDefinitions = JSON.parse(
  await readFile(
    new URL("./cpp-extensions-controls.json", import.meta.url),
    "utf8",
  ),
);
const shard = process.argv[2] ?? "all";
assert.ok(["all", "1", "2"].includes(shard));
const definitions = fullDefinitions.filter(
  (_, i) => shard === "all" || i % 2 === Number(shard) - 1,
);
const originals = new Map();
for (const control of fullDefinitions) {
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
    timeout: 300000,
    maxBuffer: 4 * 1048576,
  });
const run = (name) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "--test-name-pattern=^cpp-extensions " + name + " acceptance$",
    fileURLToPath(callback),
  ]);
const complete = (r) => {
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-1000));
  assert.match(r.stdout, /^# pass 1$/m);
  assert.match(r.stdout, /^# skipped 0$/m);
  assert.match(r.stdout, /^# cancelled 0$/m);
  assert.match(r.stdout, /^# tests 1$/m);
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
        `import assert from 'node:assert/strict';import {cppExtensionsFixture} from './dist/test/cpp-extensions-fixture.js';import {validate} from './dist/src/engine.js';import {cppExtensionsPacketSchema} from './dist/src/cpp-extensions-packet.js';import {cppExtensionsGraph} from './dist/src/cpp-extensions-graph.js';import {cppCtest,cppCtestConsole} from './dist/src/cpp-native.js';
const cleanup=[];try{const {root}=await cppExtensionsFixture({after:f=>cleanup.push(f)},['ctest']);const report=await validate(root,{trusted:true,timeoutMs:120000});const reached=report.checks[0].processes[0];assert.equal(reached.exitCode,0,reached.stderr.slice(-1500));const packet=cppExtensionsPacketSchema.parse(JSON.parse(reached.stdout));const build=packet.receipts.find(r=>r.phase==='build');assert.equal(build.exitCode,0);const artifact=file=>{if(file==='file-api-index'){const indexes=packet.artifacts.filter(a=>a.path.startsWith('.cmake/api/v1/reply/index-')&&a.path.endsWith('.json'));assert.equal(indexes.length,1);file=indexes[0].path;}const a=packet.artifacts.find(a=>a.path===file);assert.ok(a,file);return a.text;};cppExtensionsGraph(packet.config,packet.workspace,packet.build,packet.tools,artifact);const test=packet.receipts.find(r=>r.phase==='test');assert.equal(test.exitCode,0);const names=packet.config.tests.map(t=>t.name);assert.equal(names.length,2);const result=cppCtest(artifact('results.xml'),names,test.exitCode);cppCtestConsole(test.stdout,test.stderr,names,result.tests);assert.deepEqual(result.tests,{total:2,passed:2,failed:0,skipped:0});${control.id === "native-assembler-selection" ? "assert.ok(build.stdout.includes('-fintegrated-as'));" : "assert.ok(packet.receipts.find(r=>r.phase==='list').args.includes('-R'));"}console.log(JSON.stringify({nativeCompilerCohortReached:true,nativeTestBodyReached:true,executedBodies:2}));}finally{for(const f of cleanup)await f();}`,
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
    assert.match(failed.stdout, /^# cancelled 0$/m);
    assert.match(failed.stdout, /^# tests 1$/m);
    assert.match(failed.stdout, /^# pass 0$/m);
  } finally {
    await writeFile(url, original);
  }
  complete(run(control.name));
  assert.equal(await readFile(url, "utf8"), original);
  results.push({
    id: control.id,
    callback: "cpp-extensions " + control.name + " acceptance",
    expressionsReplaced: 1,
    originalPassed: true,
    originalBaselineReusedForIdenticalBytes: true,
    mutantJavaScriptSyntaxChecked: true,
    ...(control.nativeInvocation
      ? {
          mutatedNativeInvocationCompilerCohortReached: nativeCompiled,
          nativeTestBodiesReachedUnderMutatedInvocation: nativeCompiled,
          expectedExecutedBodies: 2,
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
    profile: "cpp-extensions",
    shard,
    fullControlInventory: fullDefinitions.map((c) => c.id),
    controls: results,
    distinctOriginalBaselineCallbacks: [...baselines],
    mutantAndRestoredProcessesPerControl: 2,
    callbacks: [
      {
        file: "gate-cpp-extensions.test.js",
        sha256: hash(before),
      },
    ],
    fixtures: [
      {
        file: "cpp-extensions-fixture.js",
        sha256: hash(fixtureBefore),
      },
    ],
    fixturesUnchanged: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeCppExecutionReached: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
