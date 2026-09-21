import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const prepared = path.resolve(".checktrail/go-tools/bin");
const nativePath = prepared + path.delimiter + (process.env.PATH ?? "");
const available =
  spawnSync("staticcheck", ["-version"], {
    env: { ...process.env, PATH: nativePath },
  }).status === 0;
const good =
  '// Package sample contains synthetic validation fixtures.\npackage sample\n\nimport "strings"\n\n// Fold returns lowercase text.\nfunc Fold(value string) string { return strings.ToLower(value) }\n';
const bad = good.replace(
  "return strings.ToLower(value)",
  "strings.ToLower(value); return value",
);
test(
  "native Staticcheck catches ignored return values, surfaces suppressions and rejects incomplete Go scope",
  {
    skip: available ? false : "Prepared Staticcheck unavailable",
    timeout: 120_000,
  },
  async (t) => {
    const previous = process.env.PATH;
    process.env.PATH = nativePath;
    try {
      const root = await fixture(t, {
        "go.mod": "module example.invalid/sample\n\ngo 1.23\n",
        "value.go": good,
        "checktrail.json": JSON.stringify({
          schemaVersion: 1,
          projects: [{ path: ".", checks: ["go.staticcheck"] }],
        }),
      });
      const options = { trusted: true, timeoutMs: 120_000 };
      const passed = await validate(root, options);
      assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
      assert.equal(passed.sourceChanged, false);
      assert.ok(
        passed.checks[0]!.tools?.some(
          (tool) => tool.name === "staticcheck" && tool.status === "identified",
        ),
      );
      await writeFile(path.join(root, "value.go"), bad);
      const failed = await validate(root, options);
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.ok(
        failed.checks[0]!.findings?.some(
          (finding) =>
            finding.ruleId === "SA4017" && finding.file === "value.go",
        ),
      );
      await writeFile(
        path.join(root, "staticcheck.conf"),
        'checks = ["-all"]\n',
      );
      assert.equal((await validate(root, options)).outcome, "failed");
      await writeFile(
        path.join(root, "value.go"),
        bad.replace(
          "strings.ToLower(value);",
          "\n//lint:ignore SA4017 synthetic suppression\nstrings.ToLower(value);",
        ),
      );
      const ignored = await validate(root, options);
      assert.equal(ignored.outcome, "failed", JSON.stringify(ignored.checks));
      assert.ok(
        ignored.checks[0]!.findings?.some(
          (finding) => finding.ruleId === "SA4017" && finding.level === "note",
        ),
      );
      await writeFile(path.join(root, "value.go"), good);
      await writeFile(
        path.join(root, "excluded.go"),
        "//go:build unselected_fixture\n\npackage sample\nfunc hidden() { invalid() }\n",
      );
      assert.equal((await validate(root, options)).outcome, "incomplete");
      await writeFile(
        path.join(root, "checktrail.go-scope.json"),
        JSON.stringify({
          schemaVersion: 1,
          excludedFiles: [{ path: "excluded.go", reason: "Other target" }],
        }),
      );
      assert.equal((await validate(root, options)).outcome, "passed");
      await writeFile(path.join(root, "value.go"), bad);
      assert.equal((await validate(root, options)).outcome, "failed");
      await writeFile(path.join(root, "value.go"), good);
      await rm(path.join(root, "checktrail.go-scope.json"));
      await rm(path.join(root, "excluded.go"));
      await writeFile(path.join(root, "staticcheck.conf"), "checks = broken\n");
      assert.equal((await validate(root, options)).outcome, "incomplete");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  },
);

test("Staticcheck JSON requires valid diagnostics, complete package scope and untruncated execution", async () => {
  const { evaluate } = await import("../src/evidence.js");
  const command = { executable: "staticcheck", args: [], cwd: "." };
  const check: import("../src/types.js").Check = {
    id: "go.staticcheck",
    adapter: "go",
    project: ".",
    scope: ["value.go"],
    kind: "analysis",
    parser: "staticcheck-json",
    reason: "synthetic",
    commands: [command, command],
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
      ImportPath: "example.invalid/sample",
      GoFiles: ["value.go"],
    }),
  };
  const parse = (patch: Partial<import("../src/types.js").ProcessResult>) =>
    evaluate(check, [scope, { ...process, ...patch }], "/synthetic");
  assert.equal(parse({}).status, "passed");
  const finding = {
    code: "SA4017",
    severity: "error",
    message: "discarded value",
    location: { file: "value.go", line: 2, column: 3 },
  };
  assert.equal(
    parse({ stdout: JSON.stringify(finding), exitCode: 1 }).status,
    "failed",
  );
  for (const stdout of [
    "{",
    JSON.stringify({ ...finding, severity: "unknown" }),
    JSON.stringify({
      ...finding,
      location: { file: "/outside.go", line: 1, column: 1 },
    }),
  ])
    assert.equal(parse({ stdout }).status, "inconclusive");
  for (const flag of ["truncated", "timedOut", "cancelled"] as const)
    assert.equal(parse({ [flag]: true }).status, "inconclusive");
  assert.equal(
    parse({ stderr: "configuration failure", exitCode: 1 }).status,
    "error",
  );
  assert.equal(
    evaluate(check, [{ ...scope, stdout: "" }, process], "/synthetic").status,
    "inconclusive",
  );
});
