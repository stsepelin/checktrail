import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlan } from "../src/engine.js";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
import { fixture } from "./helpers.js";

test(".NET build is opt-in and incomplete prerequisites cannot execute", async (t) => {
  const root = await fixture(t, {
    "Original.slnx": "<Solution/>\n",
    "Counter.cs": "public class Counter {}\n",
  });
  const initial = await createPlan(root);
  assert.equal(
    initial.plan.checks.some((c) => c.id === "dotnet.build"),
    false,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.build"] }],
    }),
  );
  const planned = await createPlan(root),
    check = planned.plan.checks[0]!;
  assert.equal(check.id, "dotnet.build");
  assert.equal(check.commands.length, 0);
  assert.match(check.unavailableReason!, /inventoried checktrail.dotnet-build/);
  const result = await run(root);
  assert.equal(result.checks[0]!.status, "unavailable");
  assert.equal(result.checks[0]!.processes.length, 0);
});

test(
  "native .NET builds C#/F#/VB in fresh outputs and rejects source errors in each language",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t);
    const passed = await run(root);
    assert.equal(
      passed.checks[0]!.status,
      "passed",
      JSON.stringify(passed.checks[0]),
    );
    assert.equal(passed.checks[0]!.findingsComplete, true);
    for (const [file, broken] of [
      [
        "CSharp/Counter.cs",
        "namespace Example; public static class Counter { public static int Next(int value) => missing; }",
      ],
      [
        "FSharp/Counter.fs",
        "namespace Example\nmodule Counter =\n    let next value = missing\n",
      ],
      [
        "VisualBasic/Counter.vb",
        "Namespace Example\n Public Module Counter\n Public Function NextValue(value As Integer) As Integer\n Return missing\n End Function\n End Module\nEnd Namespace\n",
      ],
    ]) {
      const target = path.join(root, file!),
        original = await readFile(target);
      try {
        await writeFile(target, broken!);
        const failed = await run(root);
        assert.equal(
          failed.checks[0]!.status,
          "failed",
          file + JSON.stringify(failed.checks[0]),
        );
        assert.equal(failed.checks[0]!.findingsComplete, false);
        assert.match(failed.checks[0]!.reason, /source (?:errors|compilation)/);
        assert.ok(
          failed.checks[0]!.findings?.some(
            (finding) =>
              finding.level === "error" &&
              finding.file === file &&
              finding.line! > 0,
          ),
          "Native source finding points to the compiled file",
        );
      } finally {
        await writeFile(target, original);
      }
    }
    assert.equal((await run(root)).checks[0]!.status, "passed");
    for (const directory of [
      "CSharp",
      "CSharpTests",
      "FSharp",
      "FSharpTests",
      "VisualBasic",
      "VisualBasicTests",
    ])
      assert.deepEqual(
        (await readdir(path.join(root, directory))).filter((name) =>
          ["obj", "bin"].includes(name),
        ),
        [],
      );
  },
);
