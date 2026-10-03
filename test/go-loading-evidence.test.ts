import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluate } from "../src/evidence.js";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { goCompileFindings } from "../src/go-compile-evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic", args: [], cwd: "." };
const process: ProcessResult = {
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
const scope = {
  ...process,
  stdout: JSON.stringify({
    Dir: "/synthetic",
    ImportPath: "example.invalid/sample",
    GoFiles: ["value.go"],
  }),
};
function parse(parser: Check["parser"], output: unknown, exitCode = 1) {
  const check: Check = {
    id: "synthetic",
    adapter: "go",
    project: ".",
    scope: ["value.go"],
    kind: "analysis",
    parser,
    commands: [command, command],
    reason: "synthetic",
  };
  return evaluate(
    check,
    [
      scope,
      {
        ...process,
        exitCode,
        stdout:
          parser === "staticcheck-json"
            ? (output as unknown[]).map((row) => JSON.stringify(row)).join("\n")
            : JSON.stringify(output),
      },
    ],
    "/synthetic",
  );
}
const compile = {
  code: "compile",
  severity: "error",
  message: "failed caching data: permission denied",
  location: { file: "", line: 0, column: 0 },
};
const diagnostic = {
  code: "SA4017",
  severity: "error",
  message: "discarded result",
  location: { file: "value.go", line: 2, column: 3 },
};
test("Staticcheck unlocated loading errors do not become source failures", () => {
  for (const exitCode of [0, 1]) {
    const result = parse("staticcheck-json", [compile], exitCode);
    assert.equal(result.status, "error");
    assert.deepEqual(result.findings, []);
    assert.equal(result.findingsComplete, false);
  }
  const actual = parse("staticcheck-json", [
    {
      ...compile,
      message: "cannot use string as int",
      location: { file: "value.go", line: 2, column: 3 },
    },
  ]);
  assert.equal(actual.status, "failed");
  assert.deepEqual(actual.findings, [
    {
      ruleId: "compile",
      level: "error",
      message: "cannot use string as int",
      file: "value.go",
      line: 2,
    },
  ]);
  assert.equal(actual.findingsComplete, false);
  const mixed = parse("staticcheck-json", [diagnostic, compile]);
  assert.equal(mixed.status, "failed");
  assert.deepEqual(
    mixed.findings?.map((finding) => finding.ruleId),
    ["SA4017"],
  );
  assert.equal(mixed.findingsComplete, false);
  assert.match(mixed.reason, /incomplete/);
  assert.equal(
    parse("staticcheck-json", [
      { ...compile, location: { file: "/outside.go", line: 2, column: 1 } },
    ]).status,
    "inconclusive",
  );
});
const linters = [
  { Name: "staticcheck", Enabled: true },
  { Name: "typecheck", Enabled: true },
];
const typecheck = {
  FromLinter: "typecheck",
  Text: ": loading compiled Go files from cache: entry not found",
  Pos: { Filename: "/synthetic/value.go", Line: 1, Column: 0 },
};
const report = (Issues: unknown[]) => ({
  Issues,
  Report: { Linters: linters },
});
test("golangci-lint synthetic package anchors cannot certify source type errors", () => {
  const loading = parse("golangci-json", report([typecheck]));
  assert.equal(loading.status, "error");
  assert.deepEqual(loading.findings, []);
  assert.equal(loading.findingsComplete, false);
  const actual = parse(
    "golangci-json",
    report([
      {
        ...typecheck,
        Text: "cannot use string as int",
        Pos: { ...typecheck.Pos, Line: 2, Column: 3 },
      },
    ]),
  );
  assert.equal(actual.status, "failed");
  assert.deepEqual(actual.findings, [
    {
      ruleId: "typecheck",
      level: "error",
      message: "cannot use string as int",
      file: "value.go",
      line: 2,
    },
  ]);
  assert.equal(actual.findingsComplete, false);
  const issue = {
    ...typecheck,
    FromLinter: "staticcheck",
    Text: "SA4017: discarded result",
  };
  const mixed = parse("golangci-json", report([typecheck, issue]));
  assert.equal(mixed.status, "failed");
  assert.deepEqual(
    mixed.findings?.map((finding) => finding.ruleId),
    ["staticcheck"],
  );
  assert.equal(mixed.findingsComplete, false);
  assert.match(mixed.reason, /incomplete/);
  assert.equal(
    parse("golangci-json", {
      ...report([]),
      Report: {
        Linters: linters,
        Error: "package loading failed",
      },
    }).status,
    "error",
  );
});

test("wrapped Go compiler evidence requires a complete block of scoped source addresses", () => {
  const check: Check = {
    id: "synthetic",
    adapter: "go",
    project: "module",
    scope: ["value.go"],
    kind: "analysis",
    parser: "exit",
    commands: [command],
    reason: "synthetic",
  };
  const block =
    '# example.invalid/sample\n./value.go:2:27: cannot use "broken" as int\n./value.go:3:4: undefined: missing';
  const expected = [
    {
      ruleId: "compile",
      level: "error",
      message: 'cannot use "broken" as int',
      file: "module/value.go",
      line: 2,
    },
    {
      ruleId: "compile",
      level: "error",
      message: "undefined: missing",
      file: "module/value.go",
      line: 3,
    },
  ];
  for (const prefix of ["", ": ", "-: "])
    assert.deepEqual(
      goCompileFindings(check, "/synthetic", prefix + block, "compile"),
      expected,
    );
  for (const invalid of [
    block.replace("./value.go", "../outside.go"),
    "loading cache: " + block,
    "./value.go:2:27: cannot use value",
    block + "\nloading cache failed",
    block.replace(":2:27:", ":0:27:"),
    block.replace(":2:27:", ":2:0:"),
    "# example.invalid/sample",
    "# example.invalid/sample\ncache mentioned value.go:2:27: permission denied",
  ])
    assert.equal(
      goCompileFindings(check, "/synthetic", invalid, "compile"),
      undefined,
      invalid,
    );
});

for (const [check, executable, args] of [
  ["go.staticcheck", "staticcheck", ["-version"]],
  ["go.golangci-lint", "golangci-lint", ["version", "--short"]],
] as const) {
  const nativePath =
    path.resolve(".checktrail/go-tools/bin") +
    path.delimiter +
    (globalThis.process.env.PATH ?? "");
  const available =
    spawnSync(executable, [...args], {
      env: { ...globalThis.process.env, PATH: nativePath },
    }).status === 0;
  test(
    `${check} retains native compiler defects and their fixed control`,
    {
      skip: available ? false : `Prepared ${executable} unavailable`,
      timeout: 120_000,
    },
    async (t) => {
      const root = await fixture(t, {
        "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
        "value.go":
          '// Package sample holds synthetic compiler fixtures.\npackage sample\n// Value returns a number.\nfunc Value() int { return "broken" }\n',
        ".golangci.yml":
          'version: "2"\nlinters:\n  default: none\n  enable: [staticcheck]\n',
        "checktrail.json": JSON.stringify({
          schemaVersion: 1,
          projects: [{ path: ".", checks: [check], environment: ["PATH"] }],
        }),
      });
      const options = {
        trusted: true,
        timeoutMs: 120_000,
        environment: { PATH: nativePath },
      };
      const broken = await validate(root, options);
      assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
      const result = broken.checks[0]!;
      assert.ok(
        result.findings?.some(
          (finding) =>
            finding.file === "value.go" &&
            finding.line === 4 &&
            finding.message.includes("cannot use"),
        ),
        JSON.stringify(result),
      );
      assert.equal(result.findingsComplete, false);
      await writeFile(
        path.join(root, "value.go"),
        "// Package sample holds synthetic compiler fixtures.\npackage sample\n// Value returns a number.\nfunc Value() int { return 42 }\n",
      );
      const fixed = await validate(root, options);
      assert.equal(fixed.outcome, "passed", JSON.stringify(fixed.checks));
    },
  );
}
