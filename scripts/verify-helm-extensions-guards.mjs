import assert from "node:assert/strict";
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const callback = new URL(
    "../dist/test/gate-helm-extensions.test.js",
    import.meta.url,
  ),
  fixture = new URL("../dist/test/helm-extensions-fixture.js", import.meta.url),
  before = await readFile(callback),
  fixtureBefore = await readFile(fixture),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const fullDefinitions = JSON.parse(
  await readFile(
    new URL("./helm-extensions-controls.json", import.meta.url),
    "utf8",
  ),
);
const shard = process.argv[2] ?? "all";
assert.ok(["all", "1", "2"].includes(shard));
const definitions = fullDefinitions.filter(
    (_, i) => shard === "all" || i % 2 === Number(shard) - 1,
  ),
  originals = new Map();
assert.equal(
  new Set(fullDefinitions.map((c) => c.id)).size,
  fullDefinitions.length,
);
for (const c of fullDefinitions) {
  const url = new URL("../dist/src/" + c.file, import.meta.url);
  if (!originals.has(c.file))
    originals.set(c.file, await readFile(url, "utf8"));
  assert.equal(originals.get(c.file).split(c.from).length, 2, c.id);
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
    "--test-name-pattern=^helm-extensions " + name + " acceptance$",
    fileURLToPath(callback),
  ]);
const complete = (r) => {
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stdout.slice(-2500) + r.stderr.slice(-1000));
  for (const line of [
    "tests 1",
    "pass 1",
    "fail 0",
    "skipped 0",
    "cancelled 0",
  ])
    assert.match(r.stdout, new RegExp("^# " + line + "$", "m"));
};
const baselines = new Set(),
  controls = [];
for (const c of definitions) {
  process.stderr.write(
    JSON.stringify({ control: c.id, callback: c.name }) + "\n",
  );
  const url = new URL("../dist/src/" + c.file, import.meta.url),
    original = originals.get(c.file),
    mutant = original.replace(c.from, c.to);
  if (!baselines.has(c.name)) {
    complete(run(c.name));
    baselines.add(c.name);
  }
  let nativeInvocation = false;
  try {
    await writeFile(url, mutant);
    const syntax = invoke(["--check", fileURLToPath(url)]);
    assert.equal(syntax.status, 0, syntax.stderr);
    if (c.nativeInvocation) {
      const proof = invoke([
        "--input-type=module",
        "-e",
        `import assert from 'node:assert/strict';import {helmExtensionsFixture,helmExtensionsConfig}from './dist/test/helm-extensions-fixture.js';import {validate}from './dist/src/engine.js';import {helmExtensionsPacketSchema}from './dist/src/helm-extensions-packet.js';import {helmExtensionsDebug}from './dist/src/helm-extensions-native.js';const cleanup=[];try{const config=helmExtensionsConfig(),root=await helmExtensionsFixture({after:f=>cleanup.push(f)},config);const report=await validate(root,{trusted:true,timeoutMs:120000}),result=report.checks[0].processes[0];assert.equal(result.exitCode,0,result.stderr);const packet=helmExtensionsPacketSchema.parse(JSON.parse(result.stdout));assert.equal(packet.receipts.length,4);assert.ok(!packet.receipts[1].args.includes('--with-subcharts'));assert.equal(packet.receipts[1].exitCode,0);assert.match(packet.receipts[1].stdout,/1 chart\\(s\\) linted, 0 chart\\(s\\) failed/);assert.equal(packet.receipts[2].exitCode,0);assert.equal(packet.receipts[3].exitCode,0);assert.equal(packet.receipts[2].stdout.match(/^# Source:/gm).length,5);assert.equal(helmExtensionsDebug(config,packet.receipts[3].stderr,packet.chart),'');console.log(JSON.stringify({mutatedNativeLintReached:true,completeNativeChartSchemaReached:true,nativeRenderingCompleted:true,declaredChartInstances:5}));}finally{for(const f of cleanup)await f();}`,
      ]);
      assert.equal(proof.error, undefined);
      assert.equal(proof.status, 0, proof.stderr.slice(-2000));
      assert.equal(JSON.parse(proof.stdout).nativeRenderingCompleted, true);
      nativeInvocation = true;
    }
    const failed = run(c.name);
    assert.equal(failed.error, undefined);
    assert.equal(failed.signal, null);
    assert.equal(
      failed.status,
      1,
      c.id + ": " + failed.stdout.slice(-2800) + failed.stderr.slice(-1000),
    );
    assert.match(failed.stdout, /code: 'ERR_ASSERTION'/);
    for (const line of [
      "tests 1",
      "pass 0",
      "fail 1",
      "skipped 0",
      "cancelled 0",
    ])
      assert.match(failed.stdout, new RegExp("^# " + line + "$", "m"));
  } finally {
    await writeFile(url, original);
  }
  complete(run(c.name));
  assert.equal(await readFile(url, "utf8"), original);
  controls.push({
    id: c.id,
    callback: "helm-extensions " + c.name + " acceptance",
    expressionsReplaced: 1,
    originalPassed: true,
    originalBaselineReusedForIdenticalBytes: true,
    mutantJavaScriptSyntaxChecked: true,
    mutantFailedAssertion: true,
    restoredPassed: true,
    originalSha256: hash(original),
    mutantSha256: hash(mutant),
    ...(c.nativeInvocation
      ? {
          mutatedNativeLintReached: nativeInvocation,
          completeNativeChartSchemaReached: nativeInvocation,
          nativeRenderingCompleted: nativeInvocation,
          declaredChartInstances: 5,
        }
      : {}),
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
    profile: "helm-extensions",
    shard,
    fullControlInventory: fullDefinitions.map((c) => c.id),
    controls,
    distinctOriginalBaselineCallbacks: [...baselines],
    mutantAndRestoredProcessesPerControl: 2,
    callbacks: [{ file: "gate-helm-extensions.test.js", sha256: hash(before) }],
    fixtures: [
      { file: "helm-extensions-fixture.js", sha256: hash(fixtureBefore) },
    ],
    sourceRestored: true,
    callbacksUnchanged: true,
    fixturesUnchanged: true,
    allComplete: true,
    nativeHelmExecutionReached: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
