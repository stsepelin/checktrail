import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const command = { executable: "synthetic-ruff", args: [], cwd: "." };
const check: Check = {
  id: "python.ruff",
  adapter: "python",
  project: ".",
  scope: ["value.py"],
  kind: "analysis",
  parser: "ruff-json",
  commands: [command, command, command],
  reason: "Synthetic evidence",
};
const output = (stdout: string): ProcessResult => ({
  command,
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
});
const processes = () => [
  output("/synthetic/value.py\n"),
  output(
    'Resolved settings for: "/synthetic/value.py"\nlinter.rules.enabled = [\n unused-import (F401),\n]\nlinter.per_file_ignores = {}\nlinter.preview = disabled\n',
  ),
  output("[]"),
];
const parse = (value: ProcessResult[]) => evaluate(check, value, "/synthetic");

test("Ruff requires exact file and settings evidence and at least one provably active rule", () => {
  assert.equal(parse(processes()).status, "passed");
  for (const [index, text] of [
    [0, ""],
    [0, "/synthetic/value.py\n/synthetic/value.py\n"],
    [0, "/other/value.py\n"],
    [1, processes()[1]!.stdout.replace("F401", "malformed")],
    [
      1,
      processes()[1]!.stdout.replace("/synthetic/value.py", "/other/value.py"),
    ],
    [1, processes()[1]!.stdout.replace("unused-import (F401),", "")],
    [
      1,
      processes()[1]!.stdout.replace(
        "per_file_ignores = {}",
        "per_file_ignores = { data = [ unused-import (F401), ] }",
      ),
    ],
    [2, "broken-json"],
  ] as const) {
    const value = processes();
    value[index]!.stdout = text;
    assert.equal(parse(value).status, "inconclusive", text);
  }
  const failed = processes();
  failed[2]!.stdout = JSON.stringify([
    {
      code: "F401",
      filename: "/synthetic/value.py",
      message: "unused import",
      location: { row: 1, column: 1 },
    },
  ]);
  assert.equal(parse(failed).status, "failed");
  failed[2]!.exitCode = 1;
  assert.equal(parse(failed).findingsComplete, true);
  for (const code of [null, "invalid-syntax", "E999"]) {
    const syntax = structuredClone(failed);
    const diagnostics = JSON.parse(syntax[2]!.stdout);
    diagnostics[0].code = code;
    syntax[2]!.stdout = JSON.stringify(diagnostics);
    assert.equal(parse(syntax).status, "failed");
    assert.equal(parse(syntax).findingsComplete, false);
  }
  const partial = structuredClone(failed);
  partial[0]!.stdout = "";
  assert.equal(parse(partial).status, "failed");
  assert.equal(parse(partial).findingsComplete, false);
  failed[2]!.exitCode = 2;
  assert.equal(parse(failed).status, "error");
  const truncated = processes();
  truncated[1]!.truncated = true;
  assert.equal(parse(truncated).status, "inconclusive");
});
