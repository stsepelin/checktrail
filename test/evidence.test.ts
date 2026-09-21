import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evidence.js";
import { aggregate } from "../src/engine.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-runner", args: [], cwd: "." };
const check: Check = {
  id: "synthetic.test",
  adapter: "synthetic",
  project: ".",
  scope: ["unit.test.js"],
  kind: "test",
  parser: "node-events",
  commands: [command],
  reason: "Synthetic parser fixture",
};
const result: ProcessResult = {
  command,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
};
const events = (passed: number, skipped = 0, failed = 0) =>
  [
    {
      type: "test:summary",
      data: {
        file: "/synthetic/unit.test.js",
        counts: {
          tests: passed + skipped + failed,
          passed,
          skipped,
          failed,
          todo: 0,
          cancelled: 0,
        },
      },
    },
    {
      type: "test:summary",
      data: {
        counts: {
          tests: passed + skipped + failed,
          passed,
          skipped,
          failed,
          todo: 0,
          cancelled: 0,
        },
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n") + "\n";

test("requires positive non-skipped test evidence and consistent counters", () => {
  for (const stdout of [
    "",
    "some output",
    events(0),
    events(0, 2),
    events(1).replace('"tests":1', '"tests":8'),
    `${events(1)}${events(1)}`,
  ]) {
    assert.equal(
      evaluate(check, [{ ...result, stdout }]).status,
      "inconclusive",
    );
  }
  const good = evaluate(check, [{ ...result, stdout: events(2, 1) }]);
  assert.equal(good.status, "passed");
  assert.deepEqual(good.tests, { total: 3, passed: 2, skipped: 1, failed: 0 });
  assert.equal(
    evaluate(check, [{ ...result, stdout: events(1, 0, 1) }]).status,
    "failed",
  );
});

test("does not let success text override process failure or incomplete output", () => {
  const cases = [
    { exitCode: 1, expected: "failed" },
    { signal: "SIGKILL", expected: "error" },
    { timedOut: true, expected: "inconclusive" },
    { cancelled: true, expected: "inconclusive" },
    { truncated: true, expected: "inconclusive" },
    { errorCode: "ENOENT", expected: "unavailable" },
    { errorCode: "EACCES", expected: "error" },
  ];
  for (const { expected, ...patch } of cases)
    assert.equal(
      evaluate(check, [{ ...result, stdout: events(2), ...patch }]).status,
      expected,
    );
  assert.equal(evaluate(check, []).status, "inconclusive");
});

test("parses unittest counts including skipped and unexpected successes", () => {
  const python = { ...check, parser: "unittest" as const };
  const good = evaluate(python, [
    { ...result, stderr: "..s\nRan 3 tests in 0.001s\n\nOK (skipped=1)\n" },
  ]);
  assert.equal(good.status, "passed");
  assert.deepEqual(good.tests, { total: 3, passed: 2, skipped: 1, failed: 0 });
  assert.equal(
    evaluate(python, [{ ...result, stderr: "Ran 0 tests in 0.000s\n\nOK\n" }])
      .status,
    "inconclusive",
  );
  assert.equal(
    evaluate(python, [
      {
        ...result,
        stderr: "Ran 1 test in 0.000s\n\nFAILED (unexpected successes=1)\n",
      },
    ]).status,
    "failed",
  );
});

test("parses Go events and rejects malformed streams or packages with no tests", () => {
  const go = { ...check, parser: "go-json" as const };
  const stdout = [
    { Action: "start", Package: "example.test/demo" },
    { Action: "run", Package: "example.test/demo", Test: "TestSum" },
    { Action: "pass", Package: "example.test/demo", Test: "TestSum" },
    { Action: "run", Package: "example.test/demo", Test: "TestOptional" },
    { Action: "skip", Package: "example.test/demo", Test: "TestOptional" },
    { Action: "pass", Package: "example.test/demo" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  assert.deepEqual(evaluate(go, [{ ...result, stdout }]).tests, {
    total: 2,
    passed: 1,
    skipped: 1,
    failed: 0,
  });
  assert.equal(
    evaluate(go, [
      { ...result, stdout: '{"Action":"skip","Package":"example.test/empty"}' },
    ]).status,
    "inconclusive",
  );
  assert.equal(
    evaluate(go, [{ ...result, stdout: `${stdout}\nnot-json` }]).status,
    "inconclusive",
  );
  assert.equal(
    evaluate(go, [
      {
        ...result,
        stdout: `${stdout}\n{"Action":"start","Package":"example.test/unfinished"}`,
      },
    ]).status,
    "inconclusive",
  );
  assert.equal(
    evaluate(go, [
      {
        ...result,
        stdout: `${stdout}\n{"Action":"run","Package":"example.test/demo","Test":"TestUnfinished"}`,
      },
    ]).status,
    "inconclusive",
  );
});

test("rejects malformed or repeated unittest outcome counters", () => {
  const python = { ...check, parser: "unittest" as const };
  for (const detail of [
    "skipped=unknown",
    "skipped=0, skipped=1",
    "mystery=1",
  ]) {
    assert.equal(
      evaluate(python, [
        { ...result, stderr: `Ran 1 test in 0.001s\nOK (${detail})\n` },
      ]).status,
      "inconclusive",
    );
  }
});

test("formatting output is a failure and incomplete checks prevent aggregate success", () => {
  const format = {
    ...check,
    kind: "format" as const,
    parser: "empty" as const,
  };
  const passed = evaluate(format, [result]);
  const failed = evaluate(format, [{ ...result, stdout: "main.go\n" }]);
  const unavailable = evaluate({ ...format, unavailableReason: "missing" }, []);
  assert.equal(failed.status, "failed");
  assert.equal(aggregate([]), "incomplete");
  assert.equal(aggregate([passed]), "passed");
  assert.equal(aggregate([passed], true), "incomplete");
  assert.equal(aggregate([passed, unavailable]), "incomplete");
  assert.equal(aggregate([passed, unavailable, failed]), "failed");
});

test("TypeScript evidence requires exact paths and complete, unambiguous output", () => {
  const typescript: Check = {
    ...check,
    kind: "analysis",
    parser: "tsc-files",
    scope: ["src/main.ts"],
  };
  for (const stdout of [
    "",
    "/synthetic/other/src/main.ts\n",
    "/synthetic/src/main.ts.backup\n",
    "/synthetic/src/main.ts\nunexpected output\n",
  ]) {
    assert.equal(
      evaluate(typescript, [{ ...result, stdout }], "/synthetic").status,
      "inconclusive",
    );
  }
  const output = {
    ...result,
    stdout:
      "/synthetic/src/main.ts\n/synthetic/node_modules/typescript/lib/lib.d.ts\n",
  };
  assert.equal(evaluate(typescript, [output], "/synthetic").status, "passed");
  assert.equal(
    evaluate(typescript, [{ ...output, stderr: "warning" }], "/synthetic")
      .status,
    "inconclusive",
  );
  assert.equal(
    evaluate(typescript, [{ ...output, truncated: true }], "/synthetic").status,
    "inconclusive",
  );
});

test("failed native test executions retain complete counters while malformed and interrupted streams never invent them", () => {
  const cases = [
    { parser: "node-events" as const, stdout: events(1, 1, 1), stderr: "" },
    {
      parser: "unittest" as const,
      stdout: "",
      stderr: "Ran 3 tests in 0.001s\nFAILED (failures=1, skipped=1)\n",
    },
    {
      parser: "go-json" as const,
      stdout: [
        { Action: "start", Package: "sample" },
        ...["pass", "skip", "fail"].flatMap((action) => [
          { Action: "run", Package: "sample", Test: action },
          { Action: action, Package: "sample", Test: action },
        ]),
        { Action: "fail", Package: "sample" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      stderr: "",
    },
  ];
  for (const sample of cases) {
    const { parser, ...output } = sample;
    const failed = evaluate({ ...check, parser }, [
      { ...result, ...output, exitCode: 1 },
    ]);
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.tests, {
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
    });
    assert.equal(
      evaluate({ ...check, parser }, [
        { ...result, ...output, exitCode: 1, truncated: true },
      ]).tests,
      undefined,
    );
  }
  const malformed = evaluate(check, [
    { ...result, stdout: "incomplete output", exitCode: 1 },
  ]);
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.tests, undefined);
});
