import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { expect, native, replace, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

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
