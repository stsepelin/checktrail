import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { goScopeComplete } from "../src/go-scope.js";
import type { Check, ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";

const available = spawnSync("go", ["version"]).status === 0;
const source = "package sample\n\nfunc Value() int { return 42 }\n";
const assertion =
  'package sample\nimport "testing"\nfunc TestValue(t *testing.T) { if Value()!=42 {t.Fatal(Value())} }\n';
test(
  "native Go scope rejects build-tagged and platform-excluded files instead of reporting full validation",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
      "value.go": source,
      "value_test.go": assertion,
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["go.vet", "go.test"] }],
      }),
    });
    const passed = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.checks[1]!.tests?.passed, 1);
    await writeFile(
      path.join(root, "excluded.go"),
      '//go:build synthetic_unselected\n\npackage sample\nfunc Hidden() int { return "invalid" }\n',
    );
    const partial = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(partial.outcome, "incomplete", JSON.stringify(partial.checks));
    assert.ok(partial.checks.every((check) => check.status === "inconclusive"));
    assert.ok(
      partial.checks.every((check) =>
        check.processes.every((process) => process.exitCode === 0),
      ),
    );
    await rm(path.join(root, "excluded.go"));
    const suffix = process.platform === "darwin" ? "linux" : "darwin";
    await writeFile(
      path.join(root, `platform_${suffix}.go`),
      'package sample\nfunc Platform() int { return "invalid" }\n',
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "incomplete",
    );
    await rm(path.join(root, `platform_${suffix}.go`));
    await mkdir(path.join(root, "untested"));
    await writeFile(path.join(root, "untested/value.go"), source);
    const untested = await validate(root, {
      trusted: true,
      timeoutMs: 120_000,
    });
    assert.equal(untested.checks[0]!.status, "passed");
    assert.equal(untested.checks[1]!.status, "inconclusive");
    await writeFile(path.join(root, "untested/value_test.go"), assertion);
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "passed",
    );
    await writeFile(
      path.join(root, "value_test.go"),
      assertion.replace("Value()!=42", "Value()!=43"),
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "failed",
    );
  },
);

test("Go package evidence requires exact source membership and fully parsed object streams", () => {
  const command = { executable: "go", args: [], cwd: "." };
  const check: Check = {
    id: "go.vet",
    adapter: "go",
    project: ".",
    scope: ["value.go", "value_test.go"],
    kind: "analysis",
    parser: "go-scope-analysis",
    commands: [command],
    reason: "synthetic",
  };
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
  const item = {
    Dir: "/synthetic",
    ImportPath: "example.invalid/sample",
    GoFiles: ["value.go"],
    TestGoFiles: ["value_test.go"],
  };
  const valid = JSON.stringify(item, null, 2);
  const parses = (stdout: string) =>
    goScopeComplete(check, { ...process, stdout }, "/synthetic");
  assert.equal(parses(valid), true);
  for (const value of [
    valid + ' "junk"',
    valid + "{}",
    valid + valid,
    valid.slice(0, -1),
    JSON.stringify({ ...item, GoFiles: [] }),
    JSON.stringify({ ...item, GoFiles: ["../value.go"] }),
    JSON.stringify({ ...item, Dir: "/outside" }),
    JSON.stringify({ ...item, Error: { Err: "failed" } }),
  ])
    assert.equal(parses(value), false, value);
});
