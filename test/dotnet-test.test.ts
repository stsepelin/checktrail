import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPlan, validate } from "../src/engine.js";
import {
  dotnetTestEvidence,
  dotnetTestPacketSchema,
} from "../src/dotnet-test-evidence.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";
import { fixture } from "./helpers.js";
import type { CheckResult } from "../src/types.js";
const available =
  !!process.env.CHECKTRAIL_DOTNET_BUILD_CACHE &&
  spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" }).stdout?.includes(
    "10.0.401 [",
  );
const native = {
  skip: available
    ? false
    : "Pinned native .NET SDK/dependency cache not selected",
  timeout: 240000,
};
const run = (root: string) =>
  validate(root, { trusted: true, timeoutMs: 120000 });
const explanation = (result: CheckResult) =>
  JSON.stringify({
    status: result.status,
    reason: result.reason,
    stderr: result.processes.map((p) => p.stderr.slice(0, 512)),
  });
const expect = (result: CheckResult, status: string) =>
  assert.equal(result.status, status, explanation(result));
async function replace(root: string, file: string, old: string, value: string) {
  const original = await readFile(path.join(root, file), "utf8");
  assert.equal(
    original.split(old).length,
    2,
    "One exact source anchor: " + file,
  );
  await writeFile(path.join(root, file), original.replace(old, value));
  return original;
}
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
test(
  "native .NET test packets reject omitted forged stale and mismatched lifecycle artifact and TRX evidence",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    expect(result, "passed");
    const process = result.processes[0]!,
      baseline = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
    assert.equal(dotnetTestEvidence(check, [process]).status, "passed");
    const controls: Array<[string, (data: typeof baseline) => void]> = [];
    const add = (name: string, change: (data: typeof baseline) => void) =>
      controls.push([name, change]);
    add("missing project", (d) => {
      d.runs.pop();
    });
    add("duplicate project", (d) => {
      d.runs.push(structuredClone(d.runs[0]!));
    });
    add("stale source", (d) => {
      d.build.inputSha256 = "0".repeat(64);
    });
    add("stale dependency bytes", (d) => {
      d.build.repositoryManifest += "\n";
    });
    add("foreign helper source", (d) => {
      d.testObserverSourceSha256 = "0".repeat(64);
    });
    add("foreign helper runtime", (d) => {
      d.testObserverSha256 = "0".repeat(64);
    });
    add("foreign client PID", (d) => {
      d.runs[0]!.discoveryLauncherPid++;
    });
    add("foreign runtime", (d) => {
      d.runs[0]!.discoveryEvents[0]!.runtime = "9.0.0";
    });
    add("foreign ObjectModel", (d) => {
      d.runs[0]!.executionEvents[0]!.objectModel = "/original/foreign.dll";
    });
    add("fresh artifact digest disagrees", (d) => {
      d.runs[0]!.artifacts[0]!.sha256 = "0".repeat(64);
    });
    add("native test SDK input omitted", (d) => {
      d.build.observedArtifacts = d.build.observedArtifacts.filter(
        (p) => !p.file.endsWith("/vstest.console.dll"),
      );
    });
    add("native case omitted", (d) => {
      d.runs[0]!.discoveryEvents = d.runs[0]!.discoveryEvents.filter(
        (e) => e.type !== "discovered",
      );
    });
    add("duplicate native case", (d) => {
      d.runs[0]!.discoveryEvents.splice(
        2,
        0,
        structuredClone(
          d.runs[0]!.discoveryEvents.find((e) => e.type === "discovered")!,
        ),
      );
    });
    add("native result omitted", (d) => {
      d.runs[0]!.executionEvents = d.runs[0]!.executionEvents.filter(
        (e) => e.type !== "result",
      );
    });
    add("native result outside lifecycle", (d) => {
      const r = d.runs[0]!;
      const index = r.executionEvents.findIndex((e) => e.type === "result");
      const [item] = r.executionEvents.splice(index, 1);
      r.executionEvents.splice(1, 0, item!);
    });
    add("discovery incomplete", (d) => {
      d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discoveryFinished",
      )!.partial = [d.runs[0]!.assembly];
    });
    add("native discovery zero", (d) => {
      d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discoveryFinished",
      )!.total = 0;
    });
    add("native run canceled", (d) => {
      d.runs[0]!.executionEvents.find(
        (e) => e.type === "runFinished",
      )!.canceled = true;
    });
    add("native terminal count wrong", (d) => {
      d.runs[0]!.executionEvents.find(
        (e) => e.type === "runFinished",
      )!.executed = 0;
    });
    add("native statistics wrong", (d) => {
      d.runs[0]!.executionEvents.find((e) => e.type === "runFinished")!.stats =
        { Passed: 1 };
    });
    add("native start against foreign assembly", (d) => {
      d.runs[0]!.executionEvents.find((e) => e.type === "runStarted")!.sources =
        ["/original/foreign.dll"];
    });
    add("native class prefix near miss", (d) => {
      const e = d.runs[0]!.discoveryEvents.find(
        (e) => e.type === "discovered",
      )!;
      (e.test as { name: string }).name = "Example.CounterTestsExtra.Scale(-1)";
    });
    add("native method has no compiled symbol", (d) => {
      const run = d.runs[0]!;
      for (const event of [...run.discoveryEvents, ...run.executionEvents])
        if (
          event.test &&
          (event.test as { name: string }).name.endsWith(".Scale(-1)")
        )
          (event.test as { name: string }).name = (
            event.test as { name: string }
          ).name.replace(".Scale(-1)", ".Other(-1)");
      run.trx = run.trx.replace(
        /(<TestMethod\b[^>]* name=")Scale\(-1\)(")/,
        "$1Other(-1)$2",
      );
    });
    add("native PDB method source omitted", (d) => {
      const m = d.build.modules.find((m) => m.file === d.runs[0]!.file)!;
      m.metadata!.types.flatMap((t) => t.methods).forEach((m) => {
        m.files = [];
      });
    });
    add("native test infrastructure error", (d) => {
      d.runs[0]!.executionEvents.splice(2, 0, {
        type: "message",
        level: "Error",
        message: "Original native failure",
      });
    });
    add("native close missing", (d) => {
      d.runs[0]!.executionEvents.pop();
    });
    add("wrong native execution exit", (d) => {
      d.runs[0]!.executionExitCode = 1;
    });
    add("unreported native call", (d) => {
      d.nativeReceipts.pop();
    });
    add("extra native call", (d) => {
      d.nativeReceipts.push({
        ...structuredClone(d.nativeReceipts.at(-1)!),
        phase: "original-unreported-call",
      });
    });
    add("observer compile not clean", (d) => {
      d.nativeReceipts.find(
        (r) => r.phase === "test-observer-compile",
      )!.stdoutBytes = 1;
    });
    add("TRX result missing", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /<UnitTestResult\b[^>]*\/>|<UnitTestResult\b[\s\S]*?<\/UnitTestResult>/,
        " ",
      );
    });
    add("TRX executed counter forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace('executed="2"', 'executed="1"');
    });
    add("TRX outcome forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        'outcome="Completed"',
        'outcome="Failed"',
      );
    });
    add("TRX result duration forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /duration="[^"]+"/,
        'duration="00:00:01.0000000"',
      );
    });
    add("TRX result source forged", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.replace(
        /codeBase="[^"]+"/,
        'codeBase="/original/foreign.dll"',
      );
    });
    add("TRX entity declaration", (d) => {
      d.runs[0]!.trx =
        '<!DOCTYPE TestRun [<!ENTITY original "foreign">]>' + d.runs[0]!.trx;
    });
    add("TRX truncated", (d) => {
      d.runs[0]!.trx = d.runs[0]!.trx.slice(0, -30);
    });
    for (const [name, change] of controls) {
      const packet = structuredClone(baseline);
      change(packet);
      assert.ok(
        JSON.stringify(packet) !== JSON.stringify(baseline),
        "Control changes actual native evidence: " + name,
      );
      const parsed = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(packet) },
      ]);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
  },
);
test(
  "native .NET tests retain mixed and all-skipped cases and their repaired execution",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      csharp = "CSharpTests/CounterTests.cs";
    const original = await replace(
      root,
      csharp,
      "[TestCase(-1)]",
      '[TestCase(-1, Ignore = "Original skipped boundary")]',
    );
    try {
      const mixed = (await run(root)).checks[0]!;
      expect(mixed, "inconclusive");
      assert.deepEqual(mixed.tests, {
        total: 6,
        passed: 5,
        failed: 0,
        skipped: 1,
      });
      assert.equal(mixed.findingsComplete, false);
    } finally {
      await writeFile(path.join(root, csharp), original);
    }
    const changes = [
      [
        csharp,
        "public class CounterTests",
        '[Ignore("Original skipped fixture")] public class CounterTests',
      ],
      [
        "FSharpTests/CounterTests.fs",
        "[<TestFixture>]",
        '[<TestFixture; Ignore("Original skipped fixture")>]',
      ],
      [
        "VisualBasicTests/CounterTests.vb",
        "Public Class CounterTests",
        '<Ignore("Original skipped fixture")> Public Class CounterTests',
      ],
    ];
    const saved = [];
    try {
      for (const [file, old, value] of changes)
        saved.push([file!, await replace(root, file!, old!, value!)]);
      const skipped = (await run(root)).checks[0]!;
      expect(skipped, "inconclusive");
      assert.deepEqual(skipped.tests, {
        total: 6,
        passed: 0,
        failed: 0,
        skipped: 6,
      });
      assert.equal(skipped.findingsComplete, false);
    } finally {
      for (const [file, text] of saved)
        await writeFile(path.join(root, file!), text!);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
test(
  "native .NET empty discovery and custom names without method provenance stay incomplete",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      file = "CSharpTests/CounterTests.cs",
      original = await readFile(path.join(root, file), "utf8");
    try {
      await writeFile(
        path.join(root, file),
        original.replace("[TestCase(-1)]", "").replace("[TestCase(2)]", ""),
      );
      const empty = (await run(root)).checks[0]!;
      expect(empty, "inconclusive");
      assert.equal(empty.findingsComplete, false);
      const packet = dotnetTestPacketSchema.parse(
        JSON.parse(empty.processes[0]!.stdout),
      );
      assert.equal(
        packet.runs[0]!.discoveryEvents.find(
          (e) => e.type === "discoveryFinished",
        )!.total,
        0,
        "The native empty discovery was retained",
      );
      await writeFile(
        path.join(root, file),
        original.replace(
          "[TestCase(-1)]",
          '[TestCase(-1, TestName = "Original custom case")]',
        ),
      );
      const custom = (await run(root)).checks[0]!;
      expect(custom, "passed");
      assert.equal(custom.findingsComplete, true);
      const check = (await createPlan(root)).plan.checks[0]!,
        process = custom.processes[0]!,
        missing = dotnetTestPacketSchema.parse(JSON.parse(process.stdout));
      missing.runs[0]!.nunit = null;
      const unsupported = dotnetTestEvidence(check, [
        { ...process, stdout: JSON.stringify(missing) },
      ]);
      assert.equal(unsupported.status, "inconclusive");
      assert.equal(unsupported.findingsComplete, false);
    } finally {
      await writeFile(path.join(root, file), original);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
test(
  "native .NET test classes require exact declared source roles including newly compiled siblings",
  native,
  async (t) => {
    const { root, config } = await dotnetTestFixture(t),
      file = "CSharpTests/CounterTests.cs",
      original = await readFile(path.join(root, file), "utf8"),
      target = path.join(root, "checktrail.dotnet-build.json"),
      configuration = await readFile(target);
    const sibling =
      "\npublic class CounterTestsExtra { [TestCase(-1)] [TestCase(2)] public void Other(int value) => Assert.That(value < 3, Is.True); }\n";
    try {
      await writeFile(path.join(root, file), original + sibling);
      const missing = (await run(root)).checks[0]!;
      expect(missing, "inconclusive");
      assert.equal(missing.findingsComplete, false);
      config.projects
        .find((p) => p.file === "CSharpTests/CSharpTests.csproj")!
        .testClasses.push({ file, className: "Example.CounterTestsExtra" });
      await writeFile(target, JSON.stringify(config));
      const complete = (await run(root)).checks[0]!;
      expect(complete, "passed");
      assert.deepEqual(complete.tests, {
        total: 8,
        passed: 8,
        failed: 0,
        skipped: 0,
      });
      const declared = config.projects.find(
        (p) => p.file === "CSharpTests/CSharpTests.csproj",
      )!;
      declared.kind = "library";
      declared.testClasses = [];
      await writeFile(target, JSON.stringify(config));
      const wrongRole = (await run(root)).checks[0]!;
      expect(wrongRole, "inconclusive");
      assert.equal(wrongRole.findingsComplete, false);
    } finally {
      await writeFile(path.join(root, file), original);
      await writeFile(target, configuration);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
test(
  "native .NET tests distinguish source compilation restore and fixture setup failures",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t),
      file = "CSharp/Counter.cs",
      original = await replace(
        root,
        file,
        "value + 1",
        "original_missing_symbol",
      );
    try {
      const broken = (await run(root)).checks[0]!;
      expect(broken, "failed");
      assert.equal(broken.tests, undefined);
      assert.equal(broken.findingsComplete, false);
      assert.ok(
        broken.findings?.some(
          (f) => f.ruleId === "dotnet-build/CS0103" && f.file === file,
        ),
      );
      const packet = dotnetTestPacketSchema.parse(
        JSON.parse(broken.processes[0]!.stdout),
      );
      assert.deepEqual(packet.runs, []);
      assert.equal(
        packet.nativeReceipts.some((r) =>
          r.phase.startsWith("test-execution:"),
        ),
        false,
      );
    } finally {
      await writeFile(path.join(root, file), original);
    }
    const testSource = "CSharpTests/CounterTests.cs",
      savedSource = await replace(
        root,
        testSource,
        "public class CounterTests\n{",
        'public class CounterTests\n{\n [OneTimeSetUp] public void Prepare() => throw new System.InvalidOperationException("Original fixture setup failure");',
      );
    try {
      const setup = (await run(root)).checks[0]!;
      expect(setup, "failed");
      assert.deepEqual(setup.tests, {
        total: 6,
        passed: 4,
        failed: 2,
        skipped: 0,
      });
      assert.ok(
        setup.findings?.some(
          (f) =>
            f.ruleId === "dotnet-test/case-failure" &&
            f.file === testSource &&
            f.message.includes("Original fixture setup failure"),
        ),
      );
    } finally {
      await writeFile(path.join(root, testSource), savedSource);
    }
    const lock = path.join(root, "CSharpTests/packages.lock.json"),
      saved = await readFile(lock),
      data = JSON.parse(saved.toString());
    data.dependencies["net10.0"]["NUnit"].requested = "[0.0.1, )";
    await writeFile(lock, JSON.stringify(data));
    try {
      const missing = (await run(root)).checks[0]!;
      expect(missing, "unavailable");
      assert.equal(missing.tests, undefined);
      assert.equal(missing.findingsComplete, false);
      assert.match(missing.reason!, /locked offline/);
    } finally {
      await writeFile(lock, saved);
    }
    expect((await run(root)).checks[0]!, "passed");
  },
);
test(
  "native .NET tests preserve caller-owned outputs and do not honor project filters as complete coverage",
  native,
  async (t) => {
    const { root } = await dotnetTestFixture(t);
    for (const folder of ["CSharpTests/bin", "CSharpTests/obj"]) {
      await mkdir(path.join(root, folder), { recursive: true });
      await writeFile(
        path.join(root, folder, "original.txt"),
        "Original caller data\n",
      );
    }
    const project = "CSharpTests/CSharpTests.csproj",
      original = await replace(
        root,
        project,
        "</Project>",
        "<PropertyGroup><VSTestTestCaseFilter>FullyQualifiedName~Nothing</VSTestTestCaseFilter><RunSettingsFilePath>../Original.runsettings</RunSettingsFilePath></PropertyGroup></Project>",
      );
    await writeFile(
      path.join(root, "Original.runsettings"),
      "<RunSettings><RunConfiguration><TestCaseFilter>FullyQualifiedName~Nothing</TestCaseFilter></RunConfiguration></RunSettings>",
    );
    try {
      const result = (await run(root)).checks[0]!;
      expect(result, "passed");
      assert.deepEqual(result.tests, {
        total: 6,
        passed: 6,
        failed: 0,
        skipped: 0,
      });
      for (const folder of ["CSharpTests/bin", "CSharpTests/obj"])
        assert.equal(
          await readFile(path.join(root, folder, "original.txt"), "utf8"),
          "Original caller data\n",
        );
    } finally {
      await writeFile(path.join(root, project), original);
    }
  },
);
