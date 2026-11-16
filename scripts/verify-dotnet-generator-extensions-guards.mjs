import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  loadGeneratorShards,
  selectGeneratorShard,
  parseGeneratorShardArguments,
  validateGeneratorJobContext,
  dotnetGeneratorControlIds,
  generatorGuardDefinitions,
  resolveGeneratorMutation,
} from "./dotnet-generator-shards.mjs";
export { generatorGuardDefinitions } from "./dotnet-generator-shards.mjs";

export async function verifyGeneratorGuardShard(id, context) {
  const repository = fileURLToPath(new URL("../", import.meta.url)),
    callback = new URL(
      "../dist/test/gate-dotnet-generator-extensions.test.js",
      import.meta.url,
    ),
    before = await readFile(callback),
    fixture = new URL(
      "../dist/test/dotnet-generator-extensions-fixture.js",
      import.meta.url,
    ),
    fixtureBefore = await readFile(fixture),
    hash = (s) => createHash("sha256").update(s).digest("hex");
  validateGeneratorJobContext(context);
  const loaded = await loadGeneratorShards(repository);
  const shard = selectGeneratorShard(loaded.manifest, id);
  assert.deepEqual(
    generatorGuardDefinitions.map((row) => row.id).sort(),
    [...dotnetGeneratorControlIds].sort(),
    "Native mutation definitions changed outside the shard manifest",
  );
  assert.deepEqual(
    generatorGuardDefinitions
      .filter((row) => row.nativeSource === true)
      .map((row) => row.id)
      .sort(),
    [...loaded.manifest.nativeCompileControlIds].sort(),
    "Native compile proof definitions changed",
  );
  const selectedDefinitions = shard.controls.map((control) =>
    generatorGuardDefinitions.find((row) => row.id === control),
  );
  const originals = new Map();
  for (const control of generatorGuardDefinitions) {
    const url = new URL("../dist/src/" + control.file, import.meta.url);
    if (!originals.has(control.file))
      originals.set(control.file, await readFile(url, "utf8"));
    const original = originals.get(control.file);
    resolveGeneratorMutation(control, original);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const invoke = (args) =>
    spawnSync(process.execPath, args, {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 4 * 1048576,
    });
  const run = (name) =>
    invoke([
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=1",
      "--test-name-pattern=^dotnet-generator-extensions " +
        name +
        " acceptance$",
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
  for (const control of selectedDefinitions) {
    const controlStarted = performance.now();
    process.stderr.write(
      JSON.stringify({ control: control.id, callback: control.name }) + "\n",
    );
    const url = new URL("../dist/src/" + control.file, import.meta.url),
      original = originals.get(control.file),
      experiment = resolveGeneratorMutation(control, original),
      mutant = experiment.source;
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
      assert.equal(
        hash(await readFile(url, "utf8")),
        experiment.binding.mutantSha256,
        "Written mutant differs from its bound experiment",
      );
      const checked = invoke(["--check", fileURLToPath(url)]);
      assert.equal(checked.status, 0, checked.stderr);
      if (control.nativeSource) {
        const proof = invoke([
          "--input-type=module",
          "-e",
          `
import assert from 'node:assert/strict';import {dotnetGeneratorMethodFixture} from './dist/test/dotnet-generator-extensions-fixture.js';import {validate} from './dist/src/engine.js';import {dotnetGeneratorExtensionsPacketSchema} from './dist/src/dotnet-generator-extensions-evidence.js';
const cleanup=[];try{const {root}=await dotnetGeneratorMethodFixture({after:f=>cleanup.push(f)});const report=await validate(root,{trusted:true,timeoutMs:120000});const reached=report.checks[0].processes[0];assert.equal(reached.exitCode,0,reached.stderr.slice(-1500));const packet=dotnetGeneratorExtensionsPacketSchema.parse(JSON.parse(reached.stdout));assert.ok(packet.generatorIdentity);assert.equal(packet.generatorIdentity.discovery.length,3);assert.ok(packet.generatorIdentity.discovery.every(c=>c.native.mode==="discovery"&&c.native.observation.count===5));assert.equal(packet.nativeReceipts.find(r=>r.phase==="generator-identity-observer-compile").exitCode,0);console.log(JSON.stringify({nativeObserverCompiled:true,nativeMethodDiscoveryReached:true}));}finally{for(const f of cleanup)await f();}
`,
        ]);
        assert.equal(proof.status, 0, proof.stderr.slice(-1500));
        assert.equal(JSON.parse(proof.stdout).nativeObserverCompiled, true);
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
      assert.equal(
        hash(await readFile(url, "utf8")),
        experiment.binding.mutantSha256,
        "Mutation artifact changed during its experiment",
      );
    } finally {
      await writeFile(url, original);
    }
    complete(run(control.name));
    assert.equal(await readFile(url, "utf8"), original);
    results.push({
      ...experiment.binding,
      durationMs: Math.round(performance.now() - controlStarted),
      callback: "dotnet-generator-extensions " + control.name + " acceptance",
      expressionsReplaced: 1,
      originalPassed: true,
      originalBaselineReusedForIdenticalBytes: true,
      mutantCompiled: true,
      ...(control.nativeSource
        ? { mutatedNativeObserverCompiled: nativeCompiled }
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
  return {
    schemaVersion: 1,
    profile: "dotnet-generator-extensions",
    scope: "dotnet-generator-mutation-fragment",
    shard: id,
    context,
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    expectedControlIds: shard.controls,
    controls: results,
    nativeCompileProofIds: results
      .filter((row) => row.mutatedNativeObserverCompiled === true)
      .map((row) => row.id),
    distinctOriginalBaselineCallbacks: [...baselines],
    mutantAndRestoredProcessesPerControl: 2,
    callbacks: [
      {
        file: "gate-dotnet-generator-extensions.test.js",
        sha256: hash(before),
      },
    ],
    fixtures: [
      {
        file: "dotnet-generator-extensions-fixture.js",
        sha256: hash(fixtureBefore),
      },
    ],
    fixturesUnchanged: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    fragmentComplete: true,
    wholeProfileQualification: false,
    nativeMethodObserverExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const id = parseGeneratorShardArguments(process.argv.slice(2));
  const context = validateGeneratorJobContext(
    JSON.parse(process.env.CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT),
  );
  process.stdout.write(
    JSON.stringify(await verifyGeneratorGuardShard(id, context)) + "\n",
  );
}
