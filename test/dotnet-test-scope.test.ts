import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { expect, native, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

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
