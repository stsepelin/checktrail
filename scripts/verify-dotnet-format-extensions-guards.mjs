import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callback = new URL(
    "../dist/test/gate-dotnet-format-extensions.test.js",
    import.meta.url,
  ),
  before = await readFile(callback),
  fixture = new URL(
    "../dist/test/dotnet-format-extensions-fixture.js",
    import.meta.url,
  ),
  fixtureBefore = await readFile(fixture),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const definitions = [
  {
    id: "virtual-pdb-native-project-alias",
    name: "near-miss",
    file: "dotnet-build-evidence.js",
    from: "nativeMappedDocuments.get(item.file)?.has(document.file)",
    to: "true",
  },
  {
    id: "virtual-pdb-empty-checksum",
    name: "near-miss",
    file: "dotnet-build-evidence.js",
    from: 'document.hash === ""',
    to: "true",
  },
  {
    id: "physical-line-mapping-column-bound",
    name: "near-miss",
    file: "dotnet-format-extensions-evidence.js",
    from: "start + column - 1 <= end",
    to: "true",
  },
  {
    id: "mapped-sdk-to-physical-diagnostic",
    name: "near-miss",
    file: "dotnet-format-extensions-evidence.js",
    pattern:
      "d\\.mapped\\.startLine === change\\.LineNumber &&\\s*d\\.mapped\\.startColumn === change\\.CharNumber",
    to: "d.physical.startLine === change.LineNumber &&\n                        d.physical.startColumn === change.CharNumber",
  },
  {
    id: "generated-native-whitespace",
    name: "broken",
    file: "dotnet-format-extensions-native.js",
    from: 'if(mode=="Whitespace"&&picked)result=await Formatter.FormatAsync(doc);',
    to: 'if(mode=="OriginalNoWhitespace"&&picked)result=await Formatter.FormatAsync(doc);',
    nativeSource: true,
  },
  {
    id: "native-analyzer-diagnostic-retention",
    name: "broken",
    file: "dotnet-format-extensions-native.js",
    from: "Where(d=>wanted.Contains(d.Id)&&!d.IsSuppressed&&d.Severity>=severity)",
    to: "Where(d=>false)",
    nativeSource: true,
  },
  {
    id: "ordinary-native-sdk-pipeline",
    name: "broken",
    file: "dotnet-format-extensions-native.js",
    from: "workspace,initial,ids,options,NullLogger.Instance,reports,CancellationToken.None",
    to: "workspace,initial,ImmutableArray<DocumentId>.Empty,options,NullLogger.Instance,reports,CancellationToken.None",
    nativeSource: true,
  },
  {
    id: "sdk-template-formatting-boundary",
    name: "fixed",
    file: "dotnet-format-extensions-native.js",
    from: "!generatedIds.Contains(d.Id)&&selected.Contains(d.FilePath)",
    to: "!generatedIds.Contains(d.Id)",
    nativeSource: true,
  },
  {
    id: "selected-diagnostic-category",
    name: "empty",
    file: "dotnet-format-extensions-evidence.js",
    from: "wanted.includes(diagnostic.id)",
    to: "true",
  },
  {
    id: "generated-formatting-route",
    name: "empty",
    file: "dotnet-format-extensions-evidence.js",
    from: 'doc.route ===\n                    (doc.sourceGenerated\n                        ? phase.mode === "Whitespace"\n                            ? "native-generated-whitespace"\n                            : "native-generated-diagnostics"\n                        : "sdk-pipeline")',
    to: "true",
  },
  {
    id: "native-constructor-abi",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "isDeepStrictEqual(native.constructorParameters, dotnetFormatExtensionsConstructorParameters)",
    to: "true",
  },
  {
    id: "formatter-assembly-identity",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "native.formatterSha256 ===\n                formatterPins.find((p) => path.join(f.sdkRoot, p.file) === native.formatterAssembly).sha256",
    to: "true",
  },
  {
    id: "current-complete-dependency-tree",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: 'repositoryBytes.toString("utf8") === build.repositoryManifest &&\n            same(walk(repositoryRoot, "."), repository.files.map((p) => p.path))',
    to: 'repositoryBytes.toString("utf8") === build.repositoryManifest && true',
  },
  {
    id: "selected-sdk-identity",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "f.sdkPinsSha256 === mavenHash(JSON.stringify(dotnetFormatterSdkPins))",
    to: "true",
  },
  {
    id: "first-document-source-binding",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "f.firstDocument.sourceSha256 === first.sourceSha256",
    to: "true",
  },
  {
    id: "complete-native-capture",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "capture.completeForObservedStreams",
    to: "true",
  },
  {
    id: "native-analyzer-catalogue",
    name: "empty",
    file: "dotnet-format-extensions-evidence.js",
    from: "dotnetFormatterRuleCatalogue[phase.mode][catalog.language].every((id) => catalog.supported.includes(id))",
    to: "true",
  },
  {
    id: "runtime-configuration",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "f.runtimeConfigSha256 ===\n                mavenHash(dotnetFormatExtensionsRuntimeConfig)",
    to: "true",
  },
  {
    id: "outer-native-stderr-mirror",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: "f.mirroredSha256 === mavenHash(result.stderr)",
    to: "true",
  },
  {
    id: "native-request-identity",
    name: "stale",
    file: "dotnet-format-extensions-evidence.js",
    from: 'f.requestFileSha256 ===\n                mavenHash(JSON.stringify({\n                    solution: path.join(build.workspace, invocation.config.solution),\n                    repository: nativeRepository,\n                    sources: selectedSources,\n                    styleDiagnostics: config.styleDiagnostics,\n                    analyzerDiagnostics: config.analyzerDiagnostics,\n                    severity: { info: "Info", warn: "Warning", error: "Error" }[config.severity],\n                }))',
    to: "true",
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
    timeout: 120000,
    maxBuffer: 4 * 1048576,
  });
const run = (name) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "--test-name-pattern=^dotnet-format-extensions " + name + " acceptance$",
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
for (const control of definitions) {
  process.stderr.write(
    JSON.stringify({ control: control.id, callback: control.name }) + "\n",
  );
  const url = new URL("../dist/src/" + control.file, import.meta.url),
    original = originals.get(control.file),
    mutant = original.replace(control.from, control.to);
  complete(run(control.name));
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
import assert from 'node:assert/strict';import {dotnetFormattingFixture} from './dist/test/dotnet-format-extensions-fixture.js';import {validate} from './dist/src/engine.js';import {dotnetFormatExtensionsPacketSchema} from './dist/src/dotnet-format-extensions-contract.js';
const cleanup=[];try{const root=await dotnetFormattingFixture({after:f=>cleanup.push(f)},${JSON.stringify(control.name === "fixed" ? "fixed" : "broken")});const report=await validate(root,{trusted:true,timeoutMs:120000});const reached=report.checks[0].processes[0];assert.equal(reached.exitCode,0,reached.stderr.slice(-1500));const packet=dotnetFormatExtensionsPacketSchema.parse(JSON.parse(reached.stdout));assert.ok(packet.extensions);assert.equal(packet.extensions.phases[0].status,0);assert.equal(packet.extensions.phases[1].status,0);assert.equal(packet.extensions.completed.processId,packet.extensions.phases[1].pid);console.log(JSON.stringify({nativeObserverCompiled:true,nativeFormatterReached:true}));}finally{for(const f of cleanup)await f();}
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
    callback: "dotnet-format-extensions " + control.name + " acceptance",
    expressionsReplaced: 1,
    originalPassed: true,
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
    profile: "dotnet-format-extensions",
    controls: results,
    callbacks: [
      { file: "gate-dotnet-format-extensions.test.js", sha256: hash(before) },
    ],
    fixtures: [
      {
        file: "dotnet-format-extensions-fixture.js",
        sha256: hash(fixtureBefore),
      },
    ],
    fixturesUnchanged: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeFormatterExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
