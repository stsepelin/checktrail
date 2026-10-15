import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  callback = new URL(
    "../dist/test/gate-dotnet-fsharp-format.test.js",
    import.meta.url,
  ),
  before = await readFile(callback),
  hash = (s) => createHash("sha256").update(s).digest("hex");
const definitions = [
  {
    id: "request-identity",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "packet.requestSha256 === mavenHash(serialized)",
    to: "true",
  },
  {
    id: "selected-sdk-identity",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "packet.sdkPinsSha256 === mavenHash(JSON.stringify(fsharpSdkPins))",
    to: "true",
  },
  {
    id: "observer-source",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "packet.helperSourceSha256 === mavenHash(fsharpFormatNativeSource)",
    to: "true",
  },
  {
    id: "runtime-configuration",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "packet.runtimeConfigSha256 === mavenHash(fsharpRuntimeConfig)",
    to: "true",
  },
  {
    id: "document-request",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "packet.requestFileSha256 === mavenHash(JSON.stringify({ documents }))",
    to: "true",
  },
  {
    id: "first-document-completion-binding",
    name: "stale",
    file: "fsharp-format-evidence.js",
    pattern:
      "packet\\.firstDocument\\.sourceSha256 ===\\s*native\\.documents\\[0\\]\\.sourceSha256",
    to: "true",
  },
  {
    id: "exact-formatter-assembly-inventory",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "isDeepStrictEqual(readdirSync(tools).sort(), fsharpFormatterPins.map((p) => p.file).sort())",
    to: "true",
  },
  {
    id: "complete-document-count",
    name: "empty",
    file: "fsharp-format-evidence.js",
    from: "native.documents.length === documents.length",
    to: "true",
  },
  {
    id: "format-change-truth",
    name: "empty",
    file: "fsharp-format-evidence.js",
    from: "document.changed === (text !== document.after)",
    to: "true",
  },
  {
    id: "physical-native-text",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "document.text === text",
    to: "true",
  },
  {
    id: "signature-provenance",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "document.signature === declared.signature",
    to: "true",
  },
  {
    id: "native-source-digest",
    name: "stale",
    file: "fsharp-format-evidence.js",
    from: "document.sourceSha256 === mavenHash(bytes)",
    to: "true",
  },
  {
    id: "native-validation-consistency",
    name: "empty",
    file: "fsharp-format-evidence.js",
    from: "!document.isValid",
    to: "true",
  },
  {
    id: "diagnostic-column-address",
    name: "empty",
    file: "fsharp-format-evidence.js",
    from: "range.startColumn <= lines[range.startLine - 1].length",
    to: "true",
  },
  {
    id: "complete-conditional-combinations",
    name: "empty",
    file: "fsharp-format-evidence.js",
    pattern:
      'error\\.message ===\\s*"Parsing failed for define combination\\(s\\): " \\+\\s*error\\.combinations\\.join\\(", "\\) \\+\\s*"\\."',
    to: "true",
  },
  {
    id: "native-host-version-inventory",
    name: "prerequisite",
    file: "fsharp-format.js",
    pattern:
      'JSON\\.stringify\\(\\(await readdir\\(path\\.join\\(root, directory\\)\\)\\)\\.sort\\(\\)\\) ===\\s*JSON\\.stringify\\(\\["10\\.0\\.12"\\]\\)',
    to: "true",
  },
  {
    id: "selected-sdk-component-inventory",
    name: "prerequisite",
    file: "fsharp-format.js",
    from: "JSON.stringify(actual) === JSON.stringify(expected.sort())",
    to: "true",
  },
  {
    id: "native-parser-diagnostic-retention",
    name: "broken",
    file: "fsharp-format-native.js",
    from: "diagnostics=e.Diagnostics.Select(Diagnostic).ToArray()",
    to: "diagnostics=Array.Empty<object>()",
    nativeSource: true,
  },
  {
    id: "native-conditional-retention",
    name: "broken",
    file: "fsharp-format-native.js",
    from: "combinations=e.Combinations.ToArray()",
    to: 'combinations=new[]{"no defines"}',
    nativeSource: true,
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
    "--test-name-pattern=^dotnet-fsharp-format " + name + " acceptance$",
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
import assert from 'node:assert/strict';import {fsharpFormatFixture} from './dist/test/fsharp-format-fixture.js';import {validate} from './dist/src/engine.js';import {fsharpPacketSchema} from './dist/src/fsharp-format-contract.js';
const cleanup=[];try{const root=await fsharpFormatFixture({after:f=>cleanup.push(f)},{'syntax.fs':'module Original\\nlet missing =\\n','conditional.fs':'#if ORIGINAL\\nlet first =\\n#else\\nlet second =\\n#endif\\n'});const report=await validate(root,{trusted:true,timeoutMs:120000});const process=report.checks[0].processes[0];assert.equal(process.exitCode,0);const packet=fsharpPacketSchema.parse(JSON.parse(process.stdout));assert.equal(packet.phases[0].status,0);assert.equal(packet.phases[1].status,0);console.log(JSON.stringify({nativeObserverCompiled:true,nativeFormatterReached:true}));}finally{for(const f of cleanup)await f();}
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
    callback: "dotnet-fsharp-format " + control.name + " acceptance",
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
for (const [file, original] of originals)
  assert.equal(
    await readFile(new URL("../dist/src/" + file, import.meta.url), "utf8"),
    original,
  );
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "dotnet-fsharp-format",
    controls: results,
    callbacks: [
      { file: "gate-dotnet-fsharp-format.test.js", sha256: hash(before) },
    ],
    sourceRestored: true,
    callbacksUnchanged: true,
    allComplete: true,
    nativeFormatterExecuted: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
