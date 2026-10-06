import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { native, run } from "./dotnet-build-controls.js";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";

test(
  "native .NET records declared generated inputs and rejects their undeclared presence",
  native,
  async (t) => {
    const { root, config } = await dotnetBuildFixture(t),
      project = path.join(root, "CSharp/CSharp.csproj"),
      xml = await readFile(project, "utf8");
    const generated = "CSharp/obj/Debug/net10.0/Original.Generated.cs";
    await writeFile(
      project,
      xml.replace(
        "</Project>",
        '<Target Name="OriginalGenerate" BeforeTargets="CoreCompile"><WriteLinesToFile File="$(IntermediateOutputPath)Original.Generated.cs" Lines="namespace Example { public class GeneratedMarker { } }" Overwrite="true" /><ItemGroup><Compile Include="$(IntermediateOutputPath)Original.Generated.cs" /></ItemGroup></Target></Project>',
      ),
    );
    config.projects[0]!.generatedSources = [generated];
    await writeFile(
      path.join(root, "checktrail.dotnet-build.json"),
      JSON.stringify(config),
    );
    const valid = (await run(root)).checks[0]!;
    assert.equal(
      valid.status,
      "passed",
      JSON.stringify({ status: valid.status, reason: valid.reason }),
    );
    config.projects[0]!.generatedSources = [];
    await writeFile(
      path.join(root, "checktrail.dotnet-build.json"),
      JSON.stringify(config),
    );
    const unknown = (await run(root)).checks[0]!;
    assert.equal(unknown.status, "inconclusive");
    assert.equal(unknown.findingsComplete, false);
    await assert.rejects(access(path.join(root, generated)));
  },
);
