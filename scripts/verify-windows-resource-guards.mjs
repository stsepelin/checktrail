import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
assert.equal(
  process.platform,
  "win32",
  "Resource guard controls require native Windows",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const source = new URL("../dist/src/windows-native.js", import.meta.url);
const callback = new URL(
  "../dist/test/windows-resource-native.test.js",
  import.meta.url,
);
const original = await readFile(source),
  callbacks = await readFile(callback);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const witness =
  "native Windows resource receipt binds direct CPU and working set separately from two reaped descendants and job CPU";
const controls = [
  {
    id: "job-user-not-direct-target-user",
    name: witness,
    from: "jobCpu = new { user100ns = info.User, kernel100ns = info.Kernel }",
    to: "jobCpu = new { user100ns = user, kernel100ns = info.Kernel }",
  },
  {
    id: "job-kernel-not-direct-target-kernel",
    name: witness,
    from: "jobCpu = new { user100ns = info.User, kernel100ns = info.Kernel }",
    to: "jobCpu = new { user100ns = info.User, kernel100ns = kernel }",
  },
  {
    id: "direct-working-set-not-commit",
    name: witness,
    from: "peak = memory.PeakWorkingSet.ToUInt64();",
    to: "peak = memory.PeakPagefile.ToUInt64();",
  },
  {
    id: "separate-native-cpu-fields",
    name: witness,
    from: "GetProcessTimes(process, out created, out exited, out kernel, out user)",
    to: "GetProcessTimes(process, out created, out exited, out user, out kernel)",
  },
  {
    id: "fixed-source-digest-before-project",
    name: "native Windows source integrity refuses changed fixed compiler bytes before project execution",
    from: "$sourceDigest -ne '${windowsNativeSourceSha256}'",
    to: "$false",
  },
];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const invoke = (args) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 65000,
    maxBuffer: 1048576,
  });
const run = (name) =>
  invoke([
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^" + name + "$",
    fileURLToPath(callback),
  ]);
function passed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
}
const receipts = [];
try {
  for (const control of controls) {
    process.stderr.write(
      JSON.stringify({
        profile: "windows-resource-guards",
        control: control.id,
        phase: "start",
      }) + "\n",
    );
    passed(run(control.name));
    const text = original.toString("utf8");
    assert.equal(text.split(control.from).length, 2, control.id);
    const mutant = text.replace(control.from, control.to);
    await writeFile(source, mutant);
    try {
      const syntax = invoke(["--check", fileURLToPath(source)]);
      assert.equal(syntax.status, 0, syntax.stderr);
      const result = run(control.name);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(
        result.status,
        1,
        control.id + "\n" + result.stdout + result.stderr,
      );
      assert.match(result.stdout, /ERR_ASSERTION/);
      assert.match(result.stdout, /^# fail 1$/m);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /error CS\d|SyntaxError|CompilerError|WINDOWS_NATIVE_COMPILATION_UNAVAILABLE/i,
      );
    } finally {
      await writeFile(source, original);
    }
    passed(run(control.name));
    assert.deepEqual(await readFile(callback), callbacks);
    receipts.push({
      id: control.id,
      callback: control.name,
      originalPassed: true,
      javascriptParsed: true,
      mutantFailedUnchangedAssertion: true,
      restoredPassed: true,
      mutantSha256: hash(mutant),
    });
  }
} finally {
  await writeFile(source, original);
}
assert.deepEqual(await readFile(source), original);
process.stdout.write(
  JSON.stringify({
    profile: "windows-job-resource-guards-v1",
    controls: receipts,
    sourceSha256: hash(original),
    callbackSha256: hash(callbacks),
    sourceRestored: true,
    callbacksUnchanged: true,
    complete: true,
    nativeQualificationRequired: true,
    inferenceInvoked: false,
  }) + "\n",
);
