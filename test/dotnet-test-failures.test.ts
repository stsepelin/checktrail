import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { dotnetTestPacketSchema } from "../src/dotnet-test-evidence.js";
import { expect, native, replace, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

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
