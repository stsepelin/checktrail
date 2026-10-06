import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  windowsNativeCode,
  windowsCompressedNative,
} from "../src/windows-native.js";
import {
  quoteWindowsArgument,
  windowsCommandLine,
  windowsEnvironment,
  windowsEncodedSupervisor,
} from "../src/windows-process.js";
test("Windows literal argument encoding follows exact quote backslash empty and command length boundaries", () => {
  assert.equal(
    gunzipSync(Buffer.from(windowsCompressedNative, "base64")).toString("utf8"),
    windowsNativeCode,
  );
  assert.equal(quoteWindowsArgument(""), '""');
  assert.equal(quoteWindowsArgument("ordinary"), '"ordinary"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument("a\\"), '"a\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.equal(
    quoteWindowsArgument("$(canary); & %PATH% ^ ! < >"),
    '"$(canary); & %PATH% ^ ! < >"',
  );
  assert.throws(() => quoteWindowsArgument("a\0b"), /INVALID_WINDOWS_ARGUMENT/);
  assert.equal(windowsCommandLine("e", ["x".repeat(32760)]).length, 32766);
  assert.throws(
    () => windowsCommandLine("e", ["x".repeat(32761)]),
    /WINDOWS_COMMAND_LINE_LIMIT/,
  );
  assert.ok(
    windowsCommandLine(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        windowsEncodedSupervisor,
      ],
    ).length < 20000,
  );
});
test("Windows environment matching is case insensitive strips undeclared values and rejects protected collisions", () => {
  const source = {
    Path: "C:\\tools",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\temporary",
    SYNTHETIC_SECRET: "must-not-leave",
    USERPROFILE: "not-granted",
  };
  assert.deepEqual(
    windowsEnvironment(source, { allowed: "operator" }, { ALLOWED: "command" }),
    {
      PATH: "C:\\tools",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\temporary",
      ALLOWED: "command",
    },
  );
  assert.throws(
    () => windowsEnvironment(source, { SystemRoot: "C:\\canary" }),
    /PROTECTED_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment(source, {}, { systemroot: "C:\\canary" }),
    /PROTECTED_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment(source, { A: "one", a: "two" }),
    /AMBIGUOUS_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment({ ...source, PATH: "duplicate" }),
    /AMBIGUOUS_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment(source, { "A=B": "bad" }),
    /INVALID_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment(source, { A: "a\0b" }),
    /INVALID_WINDOWS_ENVIRONMENT/,
  );
  assert.throws(
    () => windowsEnvironment(source, { A: "x".repeat(16385) }),
    /INVALID_WINDOWS_ENVIRONMENT/,
  );
});
