import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mutationNativeEvidence,
  mutationNativeJson,
} from "../src/mutation-native-evidence.js";
import {
  mutationRecipeSchema,
  mutationReportSchema,
  projectMutations,
} from "../src/mutation.js";
import type { ProcessResult } from "../src/types.js";
import type { NativeMutationProfile } from "../src/mutation-native-schema.js";
const root = "/original",
  file = "/original/original.test.js";
function processFor(packet: unknown, exitCode = 0): ProcessResult {
  return {
    command: { executable: "original", args: [], cwd: "." },
    exitCode,
    signal: null,
    stdout: JSON.stringify(packet),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
}
function vitest(status = "passed", names: string[] = []) {
  return {
    schemaVersion: 1,
    format: "checktrail-mutation-vitest-1",
    version: "5.0.1",
    selectedFiles: [file],
    endReason: status === "failed" ? "failed" : "passed",
    unhandled: [],
    hooks: [],
    modules: [
      {
        file,
        state:
          status === "skipped"
            ? "skipped"
            : status === "failed"
              ? "failed"
              : "passed",
        errors: [],
        flat: true,
        cases: [
          {
            name: "original case",
            fullName: "original case",
            parent: "module",
            location: { line: 2, column: 1 },
            mode: status === "skipped" ? "skip" : "run",
            retry: 0,
            fails: false,
            state: status,
            errors: names.map((name) => ({ name })),
          },
        ],
      },
    ],
  };
}
function jest(status = "passed", details: unknown[] = []) {
  return {
    schemaVersion: 1,
    format: "checktrail-mutation-jest-1",
    version: "30.5.2",
    selectedFiles: [file],
    hooks: [],
    native: {
      wasInterrupted: false,
      numTodoTests: 0,
      numRuntimeErrorTestSuites: 0,
      numTotalTests: 1,
      numPassedTests: status === "passed" ? 1 : 0,
      numFailedTests: status === "failed" ? 1 : 0,
      numPendingTests: status === "pending" ? 1 : 0,
      testResults: [
        {
          testFilePath: file,
          testResults: [
            {
              title: "original case",
              ancestorTitles: [],
              failing: false,
              location: { line: 2, column: 1 },
              status,
              failureDetails: details,
              invocations: 1,
              retryReasons: [],
              retryMessages: [],
            },
          ],
        },
      ],
    },
  };
}
const observe = (profile: NativeMutationProfile, packet: unknown, exit = 0) =>
  mutationNativeEvidence(profile, processFor(packet, exit), root, [
    "original.test.js",
  ]);
test("typed flat JS receipts separate native assertions, runtime errors, skips and setup hooks", () => {
  for (const family of ["vitest", "jest"] as const) {
    const profile = (family + "-flat-tests") as NativeMutationProfile;
    const passed = family === "vitest" ? vitest() : jest(),
      failed =
        family === "vitest"
          ? vitest("failed", ["AssertionError"])
          : jest("failed", [{ matcherResult: { name: "toBe", pass: false } }]),
      body =
        family === "vitest"
          ? vitest("failed", ["TypeError"])
          : jest("failed", [{}]),
      skipped = family === "vitest" ? vitest("skipped") : jest("pending");
    assert.equal(observe(profile, passed).outcome, "passed");
    assert.equal(observe(profile, failed, 1).outcome, "assertion-failure");
    assert.equal(observe(profile, body, 1).outcome, "execution-error");
    assert.equal(observe(profile, skipped).outcome, "skipped");
    if (family === "vitest")
      (failed as ReturnType<typeof vitest>).hooks.push({
        name: "beforeEach",
        file,
        caseName: "original case",
        beforeErrors: 0,
        afterErrors: 1,
        completed: true,
      } as never);
    else
      (failed as ReturnType<typeof jest>).hooks.push({
        name: "beforeEach",
        file,
        test: "original case",
      } as never);
    assert.equal(observe(profile, failed, 1).outcome, "setup-error");
  }
});
test("interrupted Vitest setup hooks differ from completed body assertion failures", () => {
  const receipt = vitest("failed", ["AssertionError"]);
  receipt.hooks.push({
    name: "beforeEach",
    file,
    caseName: "original case",
    beforeErrors: 1,
    afterErrors: null,
    completed: false,
  } as never);
  assert.equal(observe("vitest-flat-tests", receipt, 1).outcome, "setup-error");
  receipt.hooks[0] = {
    name: "beforeEach",
    file,
    caseName: "original case",
    beforeErrors: 1,
    afterErrors: 1,
    completed: true,
  } as never;
  assert.equal(
    observe("vitest-flat-tests", receipt, 1).outcome,
    "assertion-failure",
  );
});
test("native JS counts, identity, flatness, pins, structured causes and physical completion all constrain admission", () => {
  const mutant = jest("failed", [
    { failureMessages: ["AssertionError: manufactured prose"] },
  ]);
  assert.equal(
    observe("jest-flat-tests", mutant, 1).outcome,
    "execution-error",
  );
  const wrongMatcher = jest("failed", [
    { matcherResult: { name: "toBe", pass: true } },
  ]);
  assert.equal(
    observe("jest-flat-tests", wrongMatcher, 1).outcome,
    "execution-error",
  );
  const count = jest();
  count.native.numTotalTests = 2;
  assert.equal(observe("jest-flat-tests", count).outcome, "inconclusive");
  const nested = vitest();
  nested.modules[0]!.flat = false;
  assert.equal(observe("vitest-flat-tests", nested).outcome, "inconclusive");
  const duplicate = vitest();
  duplicate.modules[0]!.cases.push({ ...duplicate.modules[0]!.cases[0]! });
  assert.equal(observe("vitest-flat-tests", duplicate).outcome, "inconclusive");
  const omitted = vitest();
  omitted.modules = [];
  assert.equal(observe("vitest-flat-tests", omitted).outcome, "inconclusive");
  const outside = vitest();
  outside.modules[0]!.file = "/other/original.test.js";
  assert.equal(observe("vitest-flat-tests", outside).outcome, "inconclusive");
  const pin = vitest();
  pin.version = "0.0.0";
  assert.equal(observe("vitest-flat-tests", pin).outcome, "inconclusive");
  const exit = processFor(vitest(), 1);
  assert.equal(
    mutationNativeEvidence("vitest-flat-tests", exit, root, [
      "original.test.js",
    ]).outcome,
    "inconclusive",
  );
  for (const key of ["truncated", "timedOut", "cancelled"] as const) {
    const process = processFor(vitest());
    process[key] = true;
    assert.equal(
      mutationNativeEvidence("vitest-flat-tests", process, root, [
        "original.test.js",
      ]).outcome,
      "inconclusive",
    );
  }
  const cleanup = processFor(vitest());
  cleanup.errorCode = "PROCESS_TREE_CLEANUP_UNAVAILABLE";
  assert.equal(
    mutationNativeEvidence("vitest-flat-tests", cleanup, root, [
      "original.test.js",
    ]).outcome,
    "inconclusive",
  );
  assert.throws(() =>
    mutationNativeJson('{"schemaVersion":1,"schemaVersion":1}'),
  );
  assert.throws(() => mutationNativeJson('{"a":1}\n{"a":2}'));
});
function pytest(phase = "call", assertion = true) {
  const item = {
    id: "test_original.py::test_original",
    file: "/original/test_original.py",
    line: 3,
  };
  return {
    schemaVersion: 1,
    format: "checktrail-mutation-pytest-1",
    python: "3.12.13",
    version: "9.1.1",
    selectedFiles: [item.file],
    exitCode: 1,
    finished: true,
    items: [item],
    deselected: [],
    collectionErrors: [],
    reports: ["setup", ...(phase === "setup" ? [] : ["call"]), "teardown"].map(
      (p) => ({
        id: item.id,
        phase: p,
        outcome: p === phase ? "failed" : "passed",
        xfail: false,
        exception:
          p === phase
            ? {
                name: assertion
                  ? "builtins.AssertionError"
                  : "builtins.TypeError",
                assertion,
              }
            : null,
      }),
    ),
  };
}
const pyObserve = (packet: unknown, exit = 1) =>
  mutationNativeEvidence("pytest-flat-tests", processFor(packet, exit), root, [
    "test_original.py",
  ]);
test("pytest exception identity and native phase are both needed for an assertion kill", () => {
  assert.equal(pyObserve(pytest()).outcome, "assertion-failure");
  assert.equal(pyObserve(pytest("setup")).outcome, "setup-error");
  assert.equal(pyObserve(pytest("teardown")).outcome, "execution-error");
  assert.equal(pyObserve(pytest("call", false)).outcome, "execution-error");
  const missing = pytest();
  missing.reports.pop();
  assert.equal(pyObserve(missing).outcome, "inconclusive");
  const duplicate = pytest();
  duplicate.reports.push({ ...duplicate.reports[0]! });
  assert.equal(pyObserve(duplicate).outcome, "inconclusive");
  const xfail = pytest();
  xfail.reports[1]!.xfail = true;
  assert.equal(pyObserve(xfail).outcome, "inconclusive");
  const wrong = pytest();
  wrong.reports[1]!.id = "test_original.py::uncollected";
  assert.equal(pyObserve(wrong).outcome, "inconclusive");
});
function php(
  kinds: string[],
  exception = "PHPUnit\\Framework\\ExpectationFailedException",
) {
  return {
    schemaVersion: 1,
    format: "checktrail-mutation-phpunit-1",
    php: "8.5.6",
    version: "13.3.4",
    selectedFiles: ["/original/OriginalTest.php"],
    exitCode: 1,
    aborted: false,
    events: kinds.map((kind) => ({
      kind,
      id: "OriginalTest::testOriginal",
      file: "/original/OriginalTest.php",
      line: 3,
      method: "testOriginal",
      class: "OriginalTest",
      ...([
        "failed",
        "error",
        "before-hook-failed",
        "after-hook-failed",
      ].includes(kind)
        ? { exception }
        : {}),
      ...(kind === "finished" ? { assertions: 1 } : {}),
    })),
  };
}
const phpObserve = (packet: unknown, exit = 1) =>
  mutationNativeEvidence("phpunit-flat-tests", processFor(packet, exit), root, [
    "OriginalTest.php",
  ]);
test("PHPUnit exact throwable and lifecycle ordering distinguish setup, body and teardown failures", () => {
  assert.equal(
    phpObserve(php(["start", "prepared", "failed", "finished"])).outcome,
    "assertion-failure",
  );
  assert.equal(phpObserve(php(["start", "failed"])).outcome, "setup-error");
  assert.equal(
    phpObserve(php(["start", "before-hook-failed", "failed"])).outcome,
    "setup-error",
  );
  assert.equal(
    phpObserve(
      php(["start", "prepared", "after-hook-failed", "failed", "finished"]),
    ).outcome,
    "execution-error",
  );
  assert.equal(
    phpObserve(php(["start", "prepared", "error", "finished"], "TypeError"))
      .outcome,
    "execution-error",
  );
  assert.equal(
    phpObserve(php(["start", "prepared", "passed", "failed", "finished"]))
      .outcome,
    "execution-error",
  );
  assert.equal(
    phpObserve(
      php(
        ["start", "prepared", "failed", "finished"],
        "PHPUnit\\Framework\\ExpectationFailedExceptionSuffix",
      ),
    ).outcome,
    "execution-error",
  );
  assert.equal(
    phpObserve(php(["start", "prepared", "finished", "failed"])).outcome,
    "inconclusive",
  );
  assert.equal(
    phpObserve(php(["start", "prepared", "prepared", "failed", "finished"]))
      .outcome,
    "inconclusive",
  );
  const empty = php([]);
  empty.exitCode = 0;
  assert.equal(phpObserve(empty, 0).outcome, "inconclusive");
  const interrupted = { ...php([]), aborted: true, exitCode: null };
  assert.equal(phpObserve(interrupted, 255).outcome, "setup-error");
  assert.equal(phpObserve(interrupted, 0).outcome, "inconclusive");
});
test("native recipe profiles are strict and do not grant execution or weaken the Node profile", () => {
  for (const profile of [
    "vitest-flat-tests",
    "jest-flat-tests",
    "pytest-flat-tests",
    "phpunit-flat-tests",
  ]) {
    const recipe = {
      schemaVersion: 1,
      profile,
      mutations: [
        { id: "original", file: "subject.js", expected: "1", replacement: "2" },
      ],
    };
    assert.equal(mutationRecipeSchema.parse(recipe).profile, profile);
    assert.throws(() =>
      mutationRecipeSchema.parse({ ...recipe, trusted: true }),
    );
    assert.throws(() =>
      mutationRecipeSchema.parse({
        ...recipe,
        mutations: [{ ...recipe.mutations[0], file: "../subject.js" }],
      }),
    );
  }
  assert.throws(() =>
    mutationRecipeSchema.parse({
      schemaVersion: 1,
      profile: "node-flat-tests",
      mutations: [],
      skipped: true,
    }),
  );
  const report = {
    schemaVersion: 1,
    engineVersion: "original",
    profile: "vitest-flat-tests",
    channel: "advisory",
    provenance: "temporary-copy-mutation-experiment",
    recipeDigest: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    finalSourceFingerprint: "b".repeat(64),
    dependencyFingerprint: "c".repeat(64),
    finalDependencyFingerprint: "c".repeat(64),
    complete: false,
    reason: "Original unavailable baseline",
    durationMs: 1,
    runtime: {
      name: "node",
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      selectedRunner: { name: "vitest", version: "5.0.1" },
    },
    counts: {
      total: 1,
      killed: 0,
      survived: 0,
      skipped: 0,
      setupError: 0,
      executionError: 0,
      invalid: 0,
      inconclusive: 0,
      notRun: 1,
    },
    excluded: ["original-private-marker"],
    trials: [
      {
        id: "original",
        file: "original-private-subject.js",
        status: "not-run",
        reason: "Original unavailable baseline",
      },
    ],
  };
  const parsed = mutationReportSchema.parse(report),
    summary = projectMutations(parsed, false);
  assert.ok(!JSON.stringify(summary).includes("original-private-"));
  assert.ok(!Object.hasOwn(summary, "trials"));
  assert.deepEqual(projectMutations(parsed, true), parsed);
});
