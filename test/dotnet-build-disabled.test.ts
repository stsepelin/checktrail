import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET disabled compiler, omitted source and prebuild failures cannot pass",
  native,
  async (t) => {
    const { root } = await dotnetBuildFixture(t),
      file = path.join(root, "CSharp/CSharp.csproj"),
      source = await readFile(file, "utf8");
    for (const [name, xml] of [
      [
        "disabled compilation",
        "<PropertyGroup><SkipCompilerExecution>true</SkipCompilerExecution></PropertyGroup>",
      ],
      [
        "omitted source",
        '<ItemGroup><Compile Remove="Counter.cs" /></ItemGroup>',
      ],
      [
        "bootstrap failure",
        '<Target Name="OriginalFailure" BeforeTargets="CoreCompile"><Error Text="original build setup control" /></Target>',
      ],
    ] as const) {
      try {
        await writeFile(file, source.replace("</Project>", xml + "</Project>"));
        const check = (await run(root)).checks[0]!;
        assert.notEqual(check.status, "passed", name);
        if (name !== "omitted source")
          assert.notEqual(
            check.status,
            "failed",
            name + " is not a source allegation",
          );
        assert.equal(check.findingsComplete, false);
      } finally {
        await writeFile(file, source);
      }
    }
  },
);
