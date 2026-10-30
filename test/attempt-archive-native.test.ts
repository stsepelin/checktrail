import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import type { ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";
const go = spawnSync("go", ["version"], { encoding: "utf8" });
const available = go.status === 0;
const goRoot = available
  ? spawnSync("go", ["env", "GOROOT"], {
      encoding: "utf8",
      env: { ...process.env, GOTOOLCHAIN: "local" },
    })
  : undefined;
if (goRoot) assert.equal(goRoot.status, 0, goRoot.stderr);
const nativePath = goRoot ? path.join(goRoot.stdout.trim(), "bin") : "";
const digest = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
function physical(result: ProcessResult) {
  assert.ok(
    result.capturedOutput,
    "Every reached version/body command retains physical output",
  );
  assert.equal(result.capturedOutput.completeForObservedStreams, true);
  for (const stream of ["stdout", "stderr"] as const) {
    assert.equal(
      result.capturedOutput[stream].base64,
      Buffer.from(result[stream]).toString("base64"),
    );
    assert.equal(result.capturedOutput[stream].sha256, digest(result[stream]));
  }
  assert.ok(result.capturedOutput.observedBytes > 0);
}
test(
  "native version and broken/fixed test commands retain physical output with exact two-case accounting",
  {
    skip: available
      ? false
      : "Native Go unavailable; this control remains unmeasured",
    timeout: 120000,
  },
  async (t) => {
    const source =
      'package original\nimport "testing"\nfunc TestBoundary(t *testing.T){if Value("grant")!=true{t.Fatal("exact identifier")}}\nfunc TestAdjacent(t *testing.T){if Value("granting")!=false{t.Fatal("adjacent identifier")}}\n';
    const root = await fixture(t, {
      "go.mod": "module example.invalid/original-archive\n\ngo 1.23\n",
      "value.go":
        'package original\nimport "strings"\nfunc Value(s string) bool{return strings.HasPrefix(s,"grant")}\n',
      "value_test.go": source,
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["go.test"], environment: ["PATH"] }],
      }),
    });
    for (const fixed of [false, true]) {
      if (fixed)
        await writeFile(
          path.join(root, "value.go"),
          'package original\nfunc Value(s string) bool{return s=="grant"}\n',
        );
      const report = await validate(root, {
        trusted: true,
        timeoutMs: 120000,
        environment: { PATH: nativePath },
      });
      assert.equal(
        report.outcome,
        fixed ? "passed" : "failed",
        JSON.stringify(report.checks),
      );
      assert.equal(report.checks.length, 1);
      const check = report.checks[0]!;
      assert.equal(check.tests?.total, 2);
      assert.equal(check.tests?.failed, fixed ? 0 : 1);
      assert.equal(check.tests?.passed, fixed ? 2 : 1);
      const identity = check.tools!.find((tool) => tool.name === "go")!;
      assert.equal(identity.source, "version-command");
      assert.equal(identity.status, "identified");
      assert.ok(identity.process);
      assert.match(identity.process.stdout, /^go version go/);
      physical(identity.process);
      assert.deepEqual(
        check.processes.map((result) => result.command.args),
        [
          ["list", "-json", "./..."],
          ["test", "-json", "-count=1", "./..."],
        ],
      );
      for (const result of check.processes) physical(result);
      for (const field of ["capturedOutput", "base64", "stdout", "stderr"])
        assert.equal(
          JSON.stringify(projectReport(report, false)).includes(field),
          false,
        );
    }
  },
);
