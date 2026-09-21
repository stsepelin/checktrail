import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-eslint", args: [], cwd: "." };
const check: Check = {
  id: "javascript.eslint",
  adapter: "javascript",
  project: ".",
  scope: ["source.js"],
  kind: "analysis",
  parser: "eslint-json",
  commands: [command],
  reason: "Synthetic ESLint evidence",
};
const processResult: ProcessResult = {
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
const evidence = () => ({
  schemaVersion: 1,
  toolVersion: "10.10.0",
  files: [
    {
      path: "source.js",
      configured: true,
      activeRules: 1,
      results: [
        {
          filePath: "/synthetic/source.js",
          errorCount: 0,
          warningCount: 0,
          fatalErrorCount: 0,
          messages: [] as {
            ruleId: string | null;
            severity: number;
            message: string;
            fatal?: boolean;
          }[],
        },
      ],
    },
  ],
});
function parse(value: unknown, patch: Partial<ProcessResult> = {}) {
  return evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );
}

test("ESLint parser requires every exact planned path once and evidence of enabled rules", () => {
  assert.equal(parse(evidence()).status, "passed");
  const cases: ((value: ReturnType<typeof evidence>) => void)[] = [
    (value) => {
      value.files = [];
    },
    (value) => {
      value.files.push(value.files[0]!);
    },
    (value) => {
      value.files[0]!.path = "source.js.backup";
    },
    (value) => {
      value.files[0]!.results[0]!.filePath = "/other/source.js";
    },
    (value) => {
      value.files[0]!.configured = false;
    },
    (value) => {
      value.files[0]!.activeRules = 0;
    },
    (value) => {
      value.files[0]!.results = [];
    },
    (value) => {
      value.files[0]!.results.push(value.files[0]!.results[0]!);
    },
    (value) => {
      value.schemaVersion = 99;
    },
    (value) => {
      value.toolVersion = "unknown";
    },
  ];
  for (const change of cases) {
    const value = evidence();
    change(value);
    assert.equal(parse(value).status, "inconclusive", JSON.stringify(value));
  }
});

test("ESLint parser rejects mismatched counters, malformed data and missing coverage even with exit zero", () => {
  for (const field of [
    "errorCount",
    "warningCount",
    "fatalErrorCount",
  ] as const) {
    const value = evidence();
    value.files[0]!.results[0]![field] = 1;
    assert.equal(parse(value).status, "inconclusive");
  }
  for (const value of [null, [], {}, { ...evidence(), files: "not-an-array" }])
    assert.equal(parse(value).status, "inconclusive");
  for (const patch of [
    { stdout: "invalid json" },
    { stderr: "unaccounted warning" },
    { truncated: true },
    { timedOut: true },
    { cancelled: true },
    { exitCode: 1 },
  ])
    assert.equal(parse(evidence(), patch).status, "inconclusive");
  assert.equal(parse(evidence(), { exitCode: 2 }).status, "error");
  assert.equal(
    parse(evidence(), { errorCode: "ENOENT" }).status,
    "unavailable",
  );
});

test("ESLint diagnostics fail for errors, warnings and syntax failures while unclassified warnings remain incomplete", () => {
  for (const [severity, fatal, ruleId, expected] of [
    [2, false, "no-debugger", "failed"],
    [1, false, "no-debugger", "failed"],
    [2, true, null, "failed"],
    [1, false, null, "inconclusive"],
  ] as const) {
    const value = evidence();
    const result = value.files[0]!.results[0]!;
    result.messages.push({
      severity,
      fatal,
      ruleId,
      message: "synthetic diagnostic",
    });
    result.errorCount = severity === 2 ? 1 : 0;
    result.warningCount = severity === 1 ? 1 : 0;
    result.fatalErrorCount = fatal ? 1 : 0;
    assert.equal(parse(value, { exitCode: 1 }).status, expected);
    assert.equal(parse(value).status, expected);
  }
});
