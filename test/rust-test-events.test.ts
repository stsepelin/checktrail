import assert from "node:assert/strict";
import { test } from "node:test";
import { rustTestList, rustTestRun } from "../src/rust-test-events.js";
const process = (stdout: string, exitCode = 0) => ({
  stdout,
  stderr: "",
  exitCode,
});
const names = [
  "src/lib.rs - amount (line 1)",
  "src/lib.rs - amount (line 4)",
  "src/lib.rs - amount (line 7)",
  "src/lib.rs - other (line 14)",
  "src/lib.rs - amount (line 10)",
];
const output = `
running 4 tests
test src/lib.rs - amount (line 1) ... ok
test src/lib.rs - amount (line 4) ... ignored
test src/lib.rs - amount (line 7) - compile ... ok
test src/lib.rs - other (line 14) - should panic ... ok

test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

running 1 test
test src/lib.rs - amount (line 10) - compile fail ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s

all doctests ran in 0.19s; merged doctests compilation took 0.16s
`;
test("Rust native test events reconcile multiple doctest suites compile-only modes exact names and ignored bodies", () => {
  assert.deepEqual(
    rustTestList(
      process(names.map((name) => name + ": test").join("\n") + "\n"),
      true,
    ),
    names,
  );
  const result = rustTestRun(process(output), names, [names[1]!], true);
  assert.deepEqual(result.tests, {
    total: 5,
    passed: 4,
    failed: 0,
    skipped: 1,
  });
  assert.deepEqual(
    result.cases.map((c) => c.mode),
    ["runtime", "runtime", "compile", "should-panic", "compile-fail"],
  );
  for (const patch of [
    output.replace("3 passed", "4 passed"),
    output.replace("0 filtered out", "1 filtered out"),
    output.replace(" ... ok", " ... FAILED"),
    output.replace(" - compile ...", " - compile_other ..."),
    output.replace("running 1 test", "running 2 tests"),
    output.replace(
      "test src/lib.rs - amount (line 10) - compile fail ... ok",
      "test src/lib.rs - amount (line 1) ... ok",
    ),
    output.replace(
      "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s",
      "",
    ),
  ])
    assert.throws(() => rustTestRun(process(patch), names, [names[1]!], true));
  assert.throws(() =>
    rustTestRun(process(output, 101), names, [names[1]!], true),
  );
  assert.throws(() => rustTestRun(process(output), names, [], true));
});
test("Rust event parsing rejects empty interrupted duplicate benchmark and filtered evidence without treating captured failure text as success", () => {
  for (const text of [
    "one: benchmark\n",
    "one: test\none: test\n",
    "garbage\n",
  ])
    assert.throws(() => rustTestList(process(text), false));
  assert.deepEqual(rustTestList(process(""), false), []);
  const empty =
    "\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
  assert.deepEqual(rustTestRun(process(empty), [], [], false).tests, {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  });
  const failed =
    "\nrunning 1 test\ntest tests::broken ... FAILED\n\nfailures:\n\n---- tests::broken stdout ----\ntest tests::broken ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nfailures:\n    tests::broken\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
  assert.deepEqual(
    rustTestRun(process(failed, 101), ["tests::broken"], [], false).tests,
    { total: 1, passed: 0, failed: 1, skipped: 0 },
  );
  assert.throws(() =>
    rustTestRun(process(failed), ["tests::broken"], [], false),
  );
  assert.throws(() =>
    rustTestRun(
      process("running 1 test\ntest tests::broken ... ok\n"),
      ["tests::broken"],
      [],
      false,
    ),
  );
});

test("Rust expected-panic labels preserve the exact listed unit identity while unsupported suffixes stay incomplete", () => {
  const stdout =
    "\nrunning 1 test\ntest tests::panics - should panic ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
  assert.deepEqual(
    rustTestRun(process(stdout), ["tests::panics"], [], false).cases,
    [{ name: "tests::panics", status: "passed", mode: "should-panic" }],
  );
  assert.throws(() =>
    rustTestRun(
      process(stdout.replace(" - should panic", " - compile")),
      ["tests::panics"],
      [],
      false,
    ),
  );
  assert.throws(() => rustTestRun(process(""), [], [], false));
});
