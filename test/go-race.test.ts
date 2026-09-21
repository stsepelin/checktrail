import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const available = spawnSync("go", ["version"]).status === 0;
const manifest = "module example.invalid/racefixture\n\ngo 1.23\n";
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["go.test-race"] }],
});
const broken = `package racefixture
import (
 "sync"
 "testing"
)
func TestConcurrentCounter(t *testing.T) {
 var counter int
 var done sync.WaitGroup
 done.Add(2)
 for worker := 0; worker < 2; worker++ {
  go func() {
   defer done.Done()
   for iteration := 0; iteration < 1000; iteration++ { counter++ }
  }()
 }
 done.Wait()
 t.Log(counter)
}
`;
const fixed = broken
  .replace('"sync"', '"sync"\n "sync/atomic"')
  .replace("var counter int", "var counter atomic.Int64")
  .replace("counter++", "counter.Add(1)")
  .replace(
    "t.Log(counter)",
    "if counter.Load() != 2000 { t.Fatal(counter.Load()) }",
  );

test(
  "native Go race check catches unsynchronized writes and passes atomic updates",
  { skip: available ? false : "Go unavailable", timeout: 180_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "checktrail.json": policy,
      "counter_test.go": broken,
    });
    const failed = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.match(
      failed.checks[0]!.processes.map(
        (process) => process.stdout + process.stderr,
      ).join("\n"),
      /DATA RACE/,
    );
    await writeFile(path.join(root, "counter_test.go"), fixed);
    const passed = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.checks[0]!.tests?.passed, 1);
    assert.equal(passed.sourceChanged, false);
  },
);

test("Go race instrumentation requires explicit selection", async (t) => {
  const root = await fixture(t, {
    "go.mod": manifest,
    "counter_test.go": fixed,
  });
  assert.ok(
    !(await createPlan(root)).plan.checks.some(
      (check) => check.id === "go.test-race",
    ),
  );
});

test(
  "native Go race scope uses race build constraints and rejects stale exclusions",
  { skip: available ? false : "Go unavailable", timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {
      "go.mod": manifest,
      "checktrail.json": policy,
      "counter_test.go": fixed,
      "race_only.go":
        "//go:build race\n\npackage racefixture\nconst Instrumented = true\n",
      "checktrail.go-scope.json": JSON.stringify({
        schemaVersion: 1,
        excludedFiles: [
          { path: "race_only.go", reason: "Not part of ordinary tests" },
        ],
      }),
    });
    const { plan } = await createPlan(root);
    assert.deepEqual(plan.checks[0]!.commands[0]!.args, [
      "list",
      "-json",
      "-race",
      "./...",
    ]);
    const stale = await validate(root, { trusted: true, timeoutMs: 120_000 });
    assert.equal(stale.outcome, "incomplete", JSON.stringify(stale.checks));
    await writeFile(
      path.join(root, "checktrail.go-scope.json"),
      JSON.stringify({ schemaVersion: 1, excludedFiles: [] }),
    );
    assert.equal(
      (await validate(root, { trusted: true, timeoutMs: 120_000 })).outcome,
      "passed",
    );
  },
);
