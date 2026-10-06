import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "../src/dotnet-test-evidence.js";
import { createPlan } from "../src/engine.js";
import { expect, native, replace, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";
import { fixture } from "./helpers.js";

test(".NET tests are opt-in and missing declarations cannot execute during planning", async (t) => {
  const root = await fixture(t, {
    "Original.slnx": "<Solution/>\n",
    "Counter.cs": "public class Counter {}\n",
  });
  assert.equal(
    (await createPlan(root)).plan.checks.some((c) => c.id === "dotnet.test"),
    false,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.test"] }],
    }),
  );
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.equal(check.id, "dotnet.test");
  assert.equal(check.parser, "dotnet-test-json");
  assert.equal(check.commands.length, 0);
  const result = (await run(root)).checks[0]!;
  expect(result, "unavailable");
  assert.equal(result.processes.length, 0);
});

test(
  "native .NET tests reconcile every C#/F#/VB parameterized case and detect repaired boundary regressions",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t);
    const passed = (await run(root)).checks[0]!;
    expect(passed, "passed");
    assert.deepEqual(passed.tests, {
      total: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.findingsComplete, true);
    const cases = [
      [
        "CSharp/Counter.cs",
        "value + 1",
        "value < 0 ? value : value + 1",
        "CSharpTests/CounterTests.cs",
      ],
      [
        "FSharp/Counter.fs",
        "value + 1",
        "if value < 0 then value else value + 1",
        "FSharpTests/CounterTests.fs",
      ],
      [
        "VisualBasic/Counter.vb",
        "value + 1",
        "If(value < 0, value, value + 1)",
        "VisualBasicTests/CounterTests.vb",
      ],
    ];
    for (const [file, old, value, address] of cases) {
      const original = await replace(root, file!, old!, value!);
      try {
        const failed = (await run(root)).checks[0]!;
        expect(failed, "failed");
        assert.deepEqual(failed.tests, {
          total: 6,
          passed: 5,
          failed: 1,
          skipped: 0,
        });
        assert.ok(
          failed.findings?.some(
            (f) =>
              f.ruleId === "dotnet-test/case-failure" &&
              f.level === "error" &&
              f.file === address,
          ),
          "Native failure addresses the actual source-bound test",
        );
        const check = (await createPlan(root)).plan.checks[0]!,
          process = failed.processes[0]!,
          packet = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
        const failedRun = packet.runs.find((r) => r.executionExitCode === 1)!;
        failedRun.trx = failedRun.trx.slice(0, -30);
        const partial = dotnetTestEvidence(check, [
          { ...process, stdout: JSON.stringify(packet) },
        ]);
        assert.equal(
          partial.status,
          "failed",
          "A later incomplete TRX cannot erase a validated native case failure",
        );
        assert.equal(partial.findingsComplete, false);
        assert.ok(
          partial.findings?.some(
            (f) =>
              f.ruleId === "dotnet-test/case-failure" && f.file === address,
          ),
        );
      } finally {
        await writeFile(path.join(root, file!), original);
      }
    }
    const fixed = (await run(root)).checks[0]!;
    expect(fixed, "passed");
    assert.deepEqual(fixed.tests, passed.tests);
  },
);
