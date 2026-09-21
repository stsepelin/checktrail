import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-phpunit", args: [], cwd: "." };
const check: Check = {
  id: "php.phpunit",
  adapter: "php",
  project: ".",
  scope: ["ExampleTest.php"],
  kind: "test",
  parser: "phpunit-junit",
  commands: [command],
  reason: "Synthetic evidence",
};
const xml =
  '<testsuite tests="1"><testcase name="adds" file="/synthetic/ExampleTest.php" assertions="1"/></testsuite>';
const processResult: ProcessResult = {
  command,
  exitCode: 0,
  signal: null,
  stdout: xml,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
};
const parse = (patch: Partial<ProcessResult> = {}) =>
  evaluate(check, [{ ...processResult, ...patch }], "/synthetic");

test("PHPUnit requires complete file and positive assertion evidence from the live stream", () => {
  assert.equal(parse().status, "passed");
  for (const stdout of [
    xml.replace('assertions="1"', 'assertions="0"'),
    xml.replace('assertions="1"', ""),
    xml.replace("/synthetic/", "/other/"),
    xml.replace('file="/synthetic/ExampleTest.php"', ""),
    xml.slice(0, -3),
  ])
    assert.equal(parse({ stdout }).status, "inconclusive");
  assert.equal(
    evaluate(
      { ...check, scope: ["ExampleTest.php", "OmittedTest.php"] },
      [processResult],
      "/synthetic",
    ).status,
    "inconclusive",
  );
  assert.equal(parse({ exitCode: 1 }).status, "failed");
  for (const patch of [
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
  ])
    assert.equal(parse(patch).status, "inconclusive");
});

test("Pest consumes stderr XML and only strips native method suffixes inside planned paths", () => {
  const pest = { ...check, id: "php.pest" };
  const native = {
    ...processResult,
    stdout: "PASS native progress",
    stderr: xml.replace("ExampleTest.php", "ExampleTest.php::adds"),
  };
  assert.equal(evaluate(pest, [native], "/synthetic").status, "passed");
  for (const stderr of [
    native.stderr.replace("/synthetic/", "/outside/"),
    native.stderr.replace(
      "ExampleTest.php::adds",
      "ExampleTest.php.backup::adds",
    ),
    native.stderr + "trailing log",
    native.stderr.replace('assertions="1"', 'assertions="0"'),
  ])
    assert.equal(
      evaluate(pest, [{ ...native, stderr }], "/synthetic").status,
      "inconclusive",
    );
});
