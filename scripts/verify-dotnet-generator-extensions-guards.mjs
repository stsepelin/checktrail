import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
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
const definitions = [
  {
    id: "cancelled-retained-packet",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "false",
    from: "process.cancelled",
  },
  {
    id: "current-physical-input-bytes",
    name: "stale",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "mavenHash(b) === hash",
  },
  {
    id: "complete-current-dependency-tree",
    name: "stale",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "same(walk(repoRoot), repo.files.map((p) => p.path))",
  },
  {
    id: "raw-compiled-overload-signature",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "method.signature === c.methodSignature",
  },
  {
    id: "decoded-parameter-signatures",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "isDeepStrictEqual(method.parameterSignatures, c.parameterSignatures)",
  },
  {
    id: "decoded-return-signature",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "method.returnSignature === c.returnSignature",
  },
  {
    id: "current-native-helper-artifact",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "true",
    from: "n.helper.sha256 === identity.observerSha256",
  },
  {
    id: "physical-method-build-metadata-join",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    to: "need(true,",
    from: "need(sourceAgrees,",
  },
  {
    id: "complete-project-reference-graph",
    name: "empty",
    file: "dotnet-generator-extensions-evidence.js",
    pattern:
      "same\\(observedEdges, config\\.projectReferences\\.map\\(\\(r\\) => JSON\\.stringify\\(r\\)\\)\\)",
    to: "true",
  },
  {
    id: "native-method-token",
    name: "near-miss",
    file: "dotnet-generator-extensions-native.js",
    to: "methodToken=method.MetadataToken+1,",
    nativeSource: true,
    from: "methodToken=method.MetadataToken,",
  },
  {
    id: "native-inheritance-chain",
    name: "near-miss",
    file: "dotnet-generator-extensions-native.js",
    to: "type=null",
    nativeSource: true,
    from: "type=type.BaseType",
  },
  {
    id: "native-case-argument-retention",
    name: "near-miss",
    file: "dotnet-generator-extensions-native.js",
    to: "arguments=Array.Empty<object>()",
    nativeSource: true,
    from: "arguments=test.Arguments.Select(Argument).ToArray()",
  },
];
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
    timeout: 240000,
    maxBuffer: 4 * 1048576,
  });
const run = (name) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "--test-name-pattern=^dotnet-generator-extensions " + name + " acceptance$",
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
  } finally {
    await writeFile(url, original);
  }
  complete(run(control.name));
  assert.equal(await readFile(url, "utf8"), original);
  results.push({
    id: control.id,
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
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "dotnet-generator-extensions",
    controls: results,
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
    allComplete: true,
    nativeMethodObserverExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
