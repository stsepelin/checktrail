import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
assert.equal(
  process.platform,
  "win32",
  "Workspace guard requires native Windows",
);
const source = new URL("../dist/src/windows-process.js", import.meta.url),
  callback = new URL(
    "../dist/test/windows-resource-native.test.js",
    import.meta.url,
  ),
  original = await readFile(source),
  testBytes = await readFile(callback);
const name =
  "native Windows bootstrap protects a new workspace under a broadly readable temp parent before writing source or request data";
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const run = (args) =>
  spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 1048576,
  });
const observe = () =>
  run([
    "--test",
    "--test-reporter=tap",
    "--test-name-pattern=^" + name + "$",
    fileURLToPath(callback),
  ]);
const passed = (result) => {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^# pass 1$/m);
  assert.match(result.stdout, /^# skipped 0$/m);
};
passed(observe());
const before = 'ensureWindowsTaskAccess(directory, "directory", true);',
  text = original.toString("utf8");
assert.equal(text.split(before).length, 2);
const mutant = text.replace(before, ";");
try {
  await writeFile(source, mutant);
  const syntax = run(["--check", fileURLToPath(source)]);
  assert.equal(syntax.status, 0, syntax.stderr);
  const failure = observe();
  assert.equal(failure.error, undefined);
  assert.equal(failure.signal, null);
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  assert.match(failure.stdout, /ERR_ASSERTION/);
  assert.match(failure.stdout, /^# fail 1$/m);
  assert.doesNotMatch(
    failure.stdout + failure.stderr,
    /SyntaxError|error CS\d|WINDOWS_NATIVE_COMPILATION_UNAVAILABLE/,
  );
} finally {
  await writeFile(source, original);
}
passed(observe());
assert.deepEqual(await readFile(source), original);
assert.deepEqual(await readFile(callback), testBytes);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
  JSON.stringify({
    profile: "windows-workspace-guard-v1",
    callback: name,
    sourceSha256: hash(original),
    callbackSha256: hash(testBytes),
    mutantSha256: hash(mutant),
    originalPassed: true,
    javascriptParsed: true,
    removedAccessGuardFailed: true,
    restoredPassed: true,
    sourceRestored: true,
    callbacksUnchanged: true,
    inferenceInvoked: false,
  }) + "\n",
);
