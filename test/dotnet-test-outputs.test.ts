import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { expect, native, replace, run } from "./dotnet-test-controls.js";
import { dotnetTestFixture } from "./dotnet-test-fixture.js";

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
