import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { hasGoSuppression } from "../src/go-directives.js";
import { fixture } from "./helpers.js";

const nativePath =
  path.resolve(".checktrail/go-tools/bin") +
  path.delimiter +
  (process.env.PATH ?? "");
const available =
  spawnSync("golangci-lint", ["version", "--short"], {
    env: { ...process.env, PATH: nativePath },
  }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["go.golangci-lint"] }],
});
const config =
  'version: "2"\nlinters:\n  default: none\n  enable: [staticcheck]\n';
const good =
  'package sample\nimport "strings"\nfunc Fold(value string) string { return strings.ToLower(value) }\n';
const bad = good.replace(
  "return strings.ToLower(value)",
  "strings.ToLower(value); return value",
);

test(
  "native golangci-lint preserves source, disables hidden filters and validates configured checks",
  {
    skip: available ? false : "Prepared golangci-lint unavailable",
    timeout: 180_000,
  },
  async (t) => {
    const previous = process.env.PATH;
    process.env.PATH = nativePath;
    try {
      const root = await fixture(t, {
        "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
        "checktrail.json": policy,
        ".golangci.yml": config,
        "value.go": good,
      });
      const options = { trusted: true, timeoutMs: 120_000 };
      assert.equal(
        (await createPlan(root)).plan.checks[0]!.id,
        "go.golangci-lint",
      );
      const passed = await validate(root, options);
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
      assert.equal(passed.sourceChanged, false);
      await writeFile(path.join(root, "value.go"), bad);
      const broken = await validate(root, options);
      assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
      assert.ok(
        broken.checks[0]!.findings?.some(
          (finding) =>
            finding.ruleId === "staticcheck" &&
            finding.file === "value.go" &&
            finding.message.includes("SA4017"),
        ),
      );
      await writeFile(
        path.join(root, ".golangci.yml"),
        config +
          '  exclusions:\n    paths: [".*"]\nissues:\n  fix: true\n  new: true\n  new-from-rev: missing-revision\n  max-issues-per-linter: 1\noutput:\n  formats:\n    json:\n      path: should-not-write.json\n',
      );
      const filtered = await validate(root, options);
      assert.equal(filtered.outcome, "failed", JSON.stringify(filtered.checks));
      assert.equal(filtered.sourceChanged, false);
      await assert.rejects(access(path.join(root, "should-not-write.json")));
      assert.equal(await readFile(path.join(root, "value.go"), "utf8"), bad);
      await writeFile(path.join(root, ".golangci.yml"), config);
      await writeFile(
        path.join(root, "value.go"),
        good.replace(
          "func Fold",
          "//nolint:staticcheck // synthetic reason\nfunc Fold",
        ),
      );
      const suppressed = await validate(root, options);
      assert.equal(suppressed.outcome, "incomplete");
      assert.match(
        suppressed.checks[0]!.processes[1]!.stderr,
        /suppression directives/,
      );
      await writeFile(
        path.join(root, "value.go"),
        good + 'var DirectiveText = "//nolint:staticcheck"\n',
      );
      assert.equal((await validate(root, options)).outcome, "passed");
      await writeFile(
        path.join(root, "excluded.go"),
        "//go:build hidden_fixture\n\npackage sample\nfunc Hidden() { invalid() }\n",
      );
      assert.equal((await validate(root, options)).outcome, "incomplete");
      await rm(path.join(root, "excluded.go"));
      for (const value of [
        'version: "2"\nlinters:\n  default: none\n',
        config + '  settings:\n    staticcheck:\n      checks: ["-all"]\n',
        config + "formatters:\n  enable: [gofmt]\n",
        config + "run:\n  build-tags: [hidden_fixture]\n",
        'version: "2"\nversion: "2"\n',
      ]) {
        await writeFile(path.join(root, ".golangci.yml"), value);
        assert.equal(
          (await validate(root, options)).outcome,
          "incomplete",
          value,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);

test("Go suppression scanning follows comment boundaries and ignores literal or unrelated text", () => {
  for (const value of [
    "//nolint",
    "/// nolint:all",
    "// nolint:govet reason",
    "//nolint:allSuffix",
    "//lint:ignore SA4017 reason",
    "//lint:file-ignore SA4017 reason",
    "//nolint\r",
  ])
    assert.equal(hasGoSuppression(value), true, value);
  for (const value of [
    '"//nolint"',
    "'/'",
    "`//nolint\nmore`",
    "/* //nolint */",
    "//nolintExtra",
    "//discuss nolint",
    "//nolint\ttext",
    String.raw`"escaped \" //nolint"`,
  ])
    assert.equal(hasGoSuppression(value), false, value);
});

test("golangci-lint evidence needs an active configured linter and complete native scope", async () => {
  const { evaluate } = await import("../src/evidence.js");
  const command = { executable: "synthetic", args: [], cwd: "." };
  const check: import("../src/types.js").Check = {
    id: "go.golangci-lint",
    adapter: "go",
    project: ".",
    scope: ["value.go"],
    kind: "analysis",
    parser: "golangci-json",
    commands: [command, command],
    reason: "synthetic",
  };
  const process: import("../src/types.js").ProcessResult = {
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
      ImportPath: "sample",
      GoFiles: ["value.go"],
    }),
  };
  const active = [
    { Name: "staticcheck", Enabled: true },
    { Name: "typecheck", Enabled: true },
  ];
  const good = { Issues: [], Report: { Linters: active } };
  const parse = (
    value: unknown,
    patch: Partial<import("../src/types.js").ProcessResult> = {},
  ) =>
    evaluate(
      check,
      [scope, { ...process, stdout: JSON.stringify(value), ...patch }],
      "/synthetic",
    );
  assert.equal(parse(good).status, "passed");
  for (const Linters of [
    [],
    [{ Name: "typecheck", Enabled: true }],
    [...active, active[0]],
    [{ Name: "unverified", Enabled: true }],
  ])
    assert.equal(
      parse({ ...good, Report: { Linters } }).status,
      "inconclusive",
    );
  assert.equal(
    parse({
      ...good,
      Report: { Linters: active, Warnings: [{ Text: "incomplete analysis" }] },
    }).status,
    "inconclusive",
  );
  const issue = {
    FromLinter: "staticcheck",
    Text: "SA4017: ignored result",
    Pos: { Filename: "/synthetic/value.go", Line: 1, Column: 1 },
  };
  assert.equal(
    parse({ ...good, Issues: [issue] }, { exitCode: 1 }).status,
    "failed",
  );
  assert.equal(
    parse({ ...good, Issues: [issue] }, { exitCode: 1 }).findingsComplete,
    true,
  );
  for (const FromLinter of ["typecheck", "unknown"])
    assert.equal(
      parse({ ...good, Issues: [{ ...issue, FromLinter }] }, { exitCode: 1 })
        .findingsComplete,
      false,
    );
  assert.equal(
    parse({
      ...good,
      Issues: [{ ...issue, Pos: { ...issue.Pos, Filename: "/outside.go" } }],
    }).status,
    "inconclusive",
  );
  assert.equal(parse(good, { truncated: true }).status, "inconclusive");
  assert.equal(parse(good, { timedOut: true }).status, "inconclusive");
  assert.equal(parse(good, { cancelled: true }).status, "inconclusive");
});
