import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
const command = {
  executable: "synthetic-pyright",
  args: ["synthetic-runner", "/synthetic/node_modules/pyright/index.js"],
  cwd: ".",
};
const check: Check = {
  id: "python.pyright",
  adapter: "python",
  project: ".",
  scope: ["first.py", "pkg/value.pyi"],
  kind: "analysis",
  parser: "pyright-json",
  commands: [command],
  reason: "Original synthetic evidence",
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
const nativeReport = () => ({
  version: "1.1.414",
  time: "123",
  generalDiagnostics: [] as {
    file: string;
    severity: string;
    message: string;
    rule?: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }[],
  summary: {
    filesAnalyzed: 2,
    errorCount: 0,
    warningCount: 0,
    informationCount: 0,
    timeInSec: 0.1,
  },
});
const envelope = () => ({
  format: "checktrail-pyright-1",
  version: "1.1.414",
  configFiles: ["/synthetic/pyrightconfig.json"],
  policyProblems: [] as string[],
  sources: ["/synthetic/first.py", "/synthetic/pkg/value.pyi"],
  selection: {
    exitCode: 0,
    stdout:
      "Found 2 source files\n\npkg/value.pyi\n Imports     1 file\n    file:///types/builtins.pyi\n\nfirst.py\n Imports     1 file\n    file:///synthetic/pkg/value.pyi\n",
    stderr: "",
  },
  diagnostics: {
    exitCode: 0,
    stdout: JSON.stringify(nativeReport()),
    stderr: "",
  },
});
const parse = (value: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(
    check,
    [{ ...processResult, stdout: JSON.stringify(value), ...patch }],
    "/synthetic",
  );
test("Pyright requires exact native sources, active configuration and reconciled diagnostic counts", () => {
  assert.equal(parse(envelope()).status, "passed");
  const library = envelope();
  library.selection.stdout +=
    "\nnode_modules/pyright/dist/typeshed-fallback/stdlib/annotationlib.pyi\n Imports 0 files\n";
  assert.equal(parse(library).status, "passed");
  library.selection.stdout +=
    "\nnode_modules/other/hidden.py\n Imports 0 files\n";
  assert.equal(parse(library).status, "inconclusive");
  const environment = envelope();
  environment.selection.stdout =
    "  Search paths:\n    /synthetic/.venv/lib/python3.12/site-packages\n" +
    environment.selection.stdout;
  environment.selection.stdout +=
    "\n.venv/lib/python3.12/site-packages/sample/__init__.py\n Imports 0 files\n";
  assert.equal(parse(environment).status, "passed");
  environment.selection.stdout +=
    "\n.venv/lib/python3.12/site-packages_backup/hidden.py\n Imports 0 files\n";
  assert.equal(parse(environment).status, "inconclusive");

  const mutations: ((value: ReturnType<typeof envelope>) => void)[] = [
    (v) => {
      v.sources = [];
    },
    (v) => {
      v.sources.push(v.sources[0]!);
    },
    (v) => {
      v.sources[0] = "/other/first.py";
    },
    (v) => {
      v.selection.stdout = v.selection.stdout.replace(
        "pkg/value.pyi\n Imports",
        "omitted.py\n Imports",
      );
    },
    (v) => {
      v.selection.stdout += "\nfirst.py\n Imports 0 files\n";
    },
    (v) => {
      v.selection.stdout = v.selection.stdout.replace("Found 2", "Found 0");
    },
    (v) => {
      v.selection.stdout = "Found 2 source files\n";
    },
    (v) => {
      v.policyProblems.push("/synthetic/first.py");
    },
    (v) => {
      v.configFiles = [];
    },
    (v) => {
      v.version = "unverified";
    },
    (v) => {
      v.diagnostics.stderr = "Invalid setting";
    },
    (v) => {
      v.selection.stderr = "configuration warning";
    },
    (v) => {
      const r = nativeReport();
      r.summary.filesAnalyzed = 0;
      v.diagnostics.stdout = JSON.stringify(r);
    },
    (v) => {
      const r = nativeReport();
      r.summary.warningCount = 1;
      v.diagnostics.stdout = JSON.stringify(r);
    },
    (v) => {
      v.diagnostics.exitCode = 1;
    },
    (v) => {
      v.selection.exitCode = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = envelope();
    mutate(value);
    assert.equal(parse(value).status, "inconclusive", JSON.stringify(value));
  }
  for (const severity of ["error", "warning", "information"] as const) {
    const value = envelope();
    const report = nativeReport();
    report.generalDiagnostics.push({
      file: "/synthetic/first.py",
      severity,
      message: "Original synthetic diagnostic",
      rule: "reportAssignmentType",
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 4 },
      },
    });
    report.summary[`${severity}Count`] = 1;
    value.selection.exitCode = value.diagnostics.exitCode =
      severity === "information" ? 0 : 1;
    value.diagnostics.stdout = JSON.stringify(report);
    const result = parse(value, { exitCode: value.diagnostics.exitCode });
    assert.equal(
      result.status,
      severity === "information" ? "passed" : "failed",
    );
    assert.equal(result.findingsComplete, true);
    assert.deepEqual(
      result.findings?.map(({ file, line, level }) => ({ file, line, level })),
      [
        {
          file: "first.py",
          line: 2,
          level: severity === "information" ? "note" : severity,
        },
      ],
    );
    value.policyProblems.push("/synthetic/first.py");
    const suppressed = parse(value, { exitCode: value.diagnostics.exitCode });
    assert.equal(
      suppressed.status,
      severity === "information" ? "inconclusive" : "failed",
    );
    if (severity !== "information")
      assert.equal(suppressed.findingsComplete, false);
    report.generalDiagnostics[0]!.file = "/other/first.py";
    value.diagnostics.stdout = JSON.stringify(report);
    assert.equal(
      parse(value, { exitCode: value.diagnostics.exitCode }).status,
      "inconclusive",
    );
  }
  assert.equal(
    parse(
      { format: "checktrail-pyright-1", unavailable: "unverified version" },
      { exitCode: 3 },
    ).status,
    "unavailable",
  );
  assert.equal(
    parse(
      { format: "checktrail-pyright-1", error: "invalid inheritance" },
      { exitCode: 2 },
    ).status,
    "error",
  );
  const failed = envelope();
  failed.selection.exitCode = 3;
  assert.equal(parse(failed, { exitCode: 2 }).status, "error");
  for (const patch of [
    { stdout: "malformed" },
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
    { stderr: "unexpected" },
  ])
    assert.equal(parse(envelope(), patch).status, "inconclusive");
});
