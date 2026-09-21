import { projectPlan, projectReport } from "../src/output.js";
import {
  planSchema,
  planSummarySchema,
  reportSchema,
  reportSummarySchema,
} from "../src/schemas.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  writeFile,
  rm,
  mkdir,
  chmod,
  readdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
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

test(
  "native Go scope honors exact declared exclusions without hiding active errors or stale policy",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
      "value.go": source,
      "value_test.go": assertion,
      "hidden.go":
        '//go:build synthetic_unselected\n\npackage sample\nfunc Hidden() int { return "invalid" }\n',
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["go.vet", "go.test"] }],
      }),
    });
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "incomplete",
    );
    const exclusion = {
      schemaVersion: 1,
      excludedFiles: [
        {
          path: "hidden.go",
          reason: "Optional target; not checked in this host profile",
        },
      ],
    };
    const file = path.join(root, "checktrail.go-scope.json");
    await writeFile(file, JSON.stringify(exclusion));
    const selected = await validate(root, {
      trusted: true,
      timeoutMs: 120_000,
    });
    assert.equal(selected.outcome, "passed", JSON.stringify(selected.checks));
    assert.deepEqual(
      selected.checks.map((check) => check.goScope),
      [exclusion, exclusion],
    );
    assert.deepEqual(selected.checks[1]!.tests, {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    const summary = projectReport(selected, false);
    reportSummarySchema.parse(summary);
    reportSchema.parse(selected);
    assert.deepEqual(
      (summary.checks as { goExcludedFileCount: number }[]).map(
        (c) => c.goExcludedFileCount,
      ),
      [1, 1],
    );
    assert.ok(!JSON.stringify(summary).includes("hidden.go"));
    assert.ok(
      !JSON.stringify(summary).includes(exclusion.excludedFiles[0]!.reason),
    );
    await writeFile(
      path.join(root, "other.go"),
      "//go:build another_unselected\n\npackage sample\n",
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "incomplete",
    );
    await rm(path.join(root, "other.go"));
    await writeFile(
      path.join(root, "hidden.go"),
      "package sample\nfunc Hidden() int { return 7 }\n",
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "incomplete",
    );
    await writeFile(
      path.join(root, "hidden.go"),
      "//go:build synthetic_unselected\n\npackage sample\n",
    );
    await writeFile(
      path.join(root, "value_test.go"),
      assertion.replace("Value()!=42", "Value()!=43"),
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "failed",
    );
    await rm(path.join(root, "hidden.go"));
    const stale = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(stale.outcome, "incomplete");
    assert.ok(
      stale.checks.every(
        (check) =>
          check.status === "unavailable" && check.processes.length === 0,
      ),
    );
  },
);

test("Go scope planning retains policy for every native profile, keeps formatting whole and executes nothing", async (t) => {
  const root = await fixture(t, {
    "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
    "value.go": source,
    "value_test.go": assertion,
    "hidden.go": "//go:build synthetic_unselected\n\npackage sample\n",
    "checktrail.go-scope.json": JSON.stringify({
      schemaVersion: 1,
      excludedFiles: [{ path: "hidden.go", reason: "Other target" }],
    }),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: [
            "go.format",
            "go.vet",
            "go.test",
            "go.test-race",
            "go.staticcheck",
            "go.golangci-lint",
          ],
          environment: ["PATH"],
        },
      ],
    }),
    "tools/go": "#!/bin/sh\n: > executed\nexit 99\n",
  });
  await chmod(path.join(root, "tools/go"), 0o755);
  const { plan } = await createPlan(root, {
    environment: { PATH: path.join(root, "tools") },
  });
  planSchema.parse(plan);
  const summary = projectPlan(plan, false);
  planSummarySchema.parse(summary);
  assert.deepEqual(
    plan.checks
      .filter((c) => c.goScope)
      .map((c) => c.id)
      .sort(),
    ["go.golangci-lint", "go.staticcheck", "go.test", "go.test-race", "go.vet"],
  );
  assert.equal(plan.checks[0]!.id, "go.format");
  assert.equal(plan.checks[0]!.goScope, undefined);
  assert.ok(
    plan.checks[0]!.commands.some((c) => c.args.includes("./hidden.go")),
  );
  assert.ok(!JSON.stringify(summary).includes("hidden.go"));
  assert.ok(!(await readdir(root)).includes("executed"));
});

test("Go scope policy rejects globs, escapes, duplicate paths, blank reasons, foreign files and symlinks", async (t) => {
  const root = await fixture(t, {
    "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
    "value.go": source,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["go.vet"] }],
    }),
  });
  const file = path.join(root, "checktrail.go-scope.json");
  for (const value of [
    ...[
      "*.go",
      "value?.go",
      "[value].go",
      "{value}.go",
      "../value.go",
      "./value.go",
      "nested/../value.go",
      "/value.go",
      "nested//value.go",
      "nested\\value.go",
      "value\n.go",
      "missing.go",
    ].map((path) => ({
      schemaVersion: 1,
      excludedFiles: [{ path, reason: "Other target" }],
    })),
    { schemaVersion: 1, excludedFiles: [{ path: "value.go", reason: " " }] },
    {
      schemaVersion: 1,
      excludedFiles: [
        { path: "value.go", reason: "Other target" },
        { path: "value.go", reason: "Duplicate" },
      ],
    },
    { schemaVersion: 1, excludedFiles: [], unknown: true },
  ]) {
    await writeFile(file, JSON.stringify(value));
    const { plan } = await createPlan(root);
    assert.ok(plan.checks[0]!.unavailableReason, JSON.stringify(value));
  }
  await rm(file);
  await mkdir(file);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /inventoried regular file/,
  );
  await rm(file, { recursive: true });
  await writeFile(
    path.join(root, "policy.json"),
    JSON.stringify({ schemaVersion: 1, excludedFiles: [] }),
  );
  await symlink("policy.json", file);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /inventoried regular file/,
  );
});

test("Go scope exemption evidence reconciles all selected and ignored native files and test packages", () => {
  const command = { executable: "go", args: [], cwd: "." };
  const check: Check = {
    id: "go.vet",
    adapter: "go",
    project: ".",
    scope: ["value.go", "hidden.go"],
    kind: "analysis",
    parser: "go-scope-analysis",
    commands: [command],
    reason: "synthetic",
    goScope: {
      schemaVersion: 1,
      excludedFiles: [{ path: "hidden.go", reason: "Other target" }],
    },
  };
  const item = {
    Dir: "/synthetic",
    ImportPath: "example.invalid/sample",
    GoFiles: ["value.go"],
    IgnoredGoFiles: ["hidden.go"],
  };
  const result: ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(item),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  assert.equal(goScopeComplete(check, result, "/synthetic"), true);
  for (const patch of [
    { IgnoredGoFiles: [] },
    { IgnoredGoFiles: ["hidden.go", "hidden.go"] },
    { IgnoredGoFiles: ["../hidden.go"] },
    { IgnoredGoFiles: ["unknown.go"] },
    { GoFiles: ["value.go", "hidden.go"] },
    { GoFiles: [] },
  ])
    assert.equal(
      goScopeComplete(
        check,
        { ...result, stdout: JSON.stringify({ ...item, ...patch }) },
        "/synthetic",
      ),
      false,
      JSON.stringify(patch),
    );
  for (const patch of [
    { timedOut: true },
    { cancelled: true },
    { truncated: true },
    { signal: "SIGTERM" },
    { errorCode: "EPIPE" },
  ])
    assert.equal(
      goScopeComplete(check, { ...result, ...patch }, "/synthetic"),
      false,
    );
  assert.equal(
    goScopeComplete(
      check,
      result,
      "/synthetic",
      JSON.stringify({
        Action: "skip",
        Package: item.ImportPath,
        Test: "TestValue",
      }),
    ),
    false,
  );
  assert.equal(
    goScopeComplete(
      check,
      result,
      "/synthetic",
      JSON.stringify({
        Action: "pass",
        Package: item.ImportPath,
        Test: "TestValue",
      }),
    ),
    true,
  );
});
