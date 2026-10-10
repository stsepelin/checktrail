import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callback = new URL(
    "../dist/test/gate-ruby-extensions.test.js",
    import.meta.url,
  ),
  before = await readFile(callback),
  fixture = new URL("../dist/test/ruby-extensions-fixture.js", import.meta.url),
  fixtureBefore = await readFile(fixture),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const fullDefinitions = [
  {
    id: "cancelled-retained-packet",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: "false",
    from: "process.cancelled",
  },
  {
    id: "current-physical-input-bytes",
    name: "stale",
    file: "ruby-extensions-freshness.js",
    to: "true",
    from: "mavenHash(value) === hash",
  },
  {
    id: "complete-current-archive-tree",
    name: "stale",
    file: "ruby-extensions-freshness.js",
    to: "true",
    from: "rubyToolsSame(readdirSync(directory), manifest.files.map((p) => p.path))",
  },
  {
    id: "actual-evaluated-dependency-predicates",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: "true",
    from: "isDeepStrictEqual(expected, observed)",
  },
  {
    id: "actual-evaluated-source-inventory",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: '["https://rubygems.org/"]',
    from: "extension.manifest.sources",
  },
  {
    id: "shared-physical-body-location",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: "true",
    from: "c.source.line === row.line",
  },
  {
    id: "rspec-physical-receiver-identity",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: "true",
    from: "c.receiver === c.ancestors[0]",
  },
  {
    id: "rspec-hook-invocation-denominator",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: ".length >= 0",
    from: ".length === h.invocations",
  },
  {
    id: "complete-hook-registration-cohort",
    name: "empty",
    file: "ruby-tools-evidence.js",
    to: "true",
    from: "isDeepStrictEqual(order(expected), order(extension.registeredHooks))",
  },
  {
    id: "native-shared-example-inclusion",
    name: "broken",
    file: "ruby-extensions-native.js",
    to: "shared: []}",
    nativeSource: true,
    mode: "rspec",
    from: "shared: frames}",
  },
  {
    id: "native-hook-registration",
    name: "broken",
    file: "ruby-extensions-native.js",
    to: "[] << {",
    nativeSource: true,
    mode: "rspec",
    from: "extension_registered_hooks << {",
  },
  {
    id: "native-minitest-declaring-owner",
    name: "broken",
    file: "ruby-tools-native.js",
    to: "declaring: klass.name",
    nativeSource: true,
    mode: "minitest",
    from: "declaring: native_method.owner.name",
  },
  {
    id: "pinned-runtime-before-project-dsl",
    name: "prerequisite",
    file: "ruby-extensions-prerequisite.js",
    from: "return ready;",
    to: "return true;",
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
    "--test-name-pattern=^ruby-extensions " + name + " acceptance$",
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
        `import assert from 'node:assert/strict';import {rubyExtensionsFixture} from './dist/test/ruby-extensions-fixture.js';import {validate} from './dist/src/engine.js';import {rubyToolsPacketSchema} from './dist/src/ruby-tools-evidence.js';import {rubyToolsNativeSource} from './dist/src/ruby-tools-native.js';import {mavenHash} from './dist/src/maven.js';
const cleanup=[];try{const {root}=await rubyExtensionsFixture({after:f=>cleanup.push(f)},['ruby.${control.mode}-extensions']);const report=await validate(root,{trusted:true,timeoutMs:120000});const reached=report.checks[0].processes[0];assert.equal(reached.exitCode,0,reached.stderr.slice(-1500));const packet=rubyToolsPacketSchema.parse(JSON.parse(reached.stdout));assert.equal(packet.observerSha256,mavenHash(rubyToolsNativeSource));assert.equal(packet.receipts.find(r=>r.phase===${JSON.stringify(control.mode)}).exitCode,0);const data=JSON.parse(packet.data);assert.equal(data.summary.total,${control.mode === "rspec" ? 4 : 3});assert.equal(data.started.length,data.summary.total);assert.equal(data.results.length,data.summary.total);console.log(JSON.stringify({nativeObserverSyntaxChecked:true,nativeTestBodyReached:true}));}finally{for(const f of cleanup)await f();}`,
      ]);
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
    callback: "ruby-extensions " + control.name + " acceptance",
    expressionsReplaced: 1,
    originalPassed: true,
    originalBaselineReusedForIdenticalBytes: true,
    mutantJavaScriptSyntaxChecked: true,
    ...(control.nativeSource
      ? {
          mutatedNativeObserverSyntaxChecked: nativeCompiled,
          mutatedNativeTestBodyReached: nativeCompiled,
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
    profile: "ruby-extensions",
    shard,
    fullControlInventory: fullDefinitions.map((c) => c.id),
    controls: results,
    distinctOriginalBaselineCallbacks: [...baselines],
    mutantAndRestoredProcessesPerControl: 2,
    callbacks: [
      {
        file: "gate-ruby-extensions.test.js",
        sha256: hash(before),
      },
    ],
    fixtures: [
      {
        file: "ruby-extensions-fixture.js",
        sha256: hash(fixtureBefore),
      },
    ],
    fixturesUnchanged: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeRubyObserverExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
