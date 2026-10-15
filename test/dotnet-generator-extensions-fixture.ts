import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { dotnetBuildFixture } from "./dotnet-build-fixture.js";
import { mavenHash } from "../src/maven.js";
import { dotnetGeneratorExtensionsPacketSchema } from "../src/dotnet-generator-extensions-evidence.js";
import type { ProcessResult } from "../src/types.js";
import { originalGeneratorSource } from "./dotnet-generated-fixture.js";
export async function dotnetGeneratorExtensionsFixture(t: TestContext) {
  const { root, config } = await dotnetBuildFixture(t),
    edits: Array<[string, string]> = [];
  config.projects.unshift({
    file: "Generator/Generator.csproj",
    language: "csharp",
    assemblyName: "Original.Generator",
    targetFramework: "net10.0",
    kind: "library",
    sources: ["Generator/OriginalGenerator.cs"],
    generatedSources: [],
    roslynGeneratedSources: [],
    testClasses: [],
  });
  edits.push(
    [
      "Generator/Generator.csproj",
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>Original.Generator</AssemblyName><Nullable>enable</Nullable><RestorePackagesWithLockFile>true</RestorePackagesWithLockFile></PropertyGroup><ItemGroup><Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference></ItemGroup></Project>',
    ],
    [
      "Generator/packages.lock.json",
      JSON.stringify({ version: 1, dependencies: { "net10.0": {} } }),
    ],
    ["Generator/OriginalGenerator.cs", originalGeneratorSource],
  );
  for (const [directory, extension] of [
    ["CSharp", "cs"],
    ["VisualBasic", "vb"],
  ] as const) {
    const project = config.projects.find(
      (p) => p.file === `${directory}/${directory}.${extension}proj`,
    )!;
    project.roslynGeneratedSources = [
      {
        file: `${directory}/obj/Debug/net10.0/generated/Original.Generator/Example.OriginalGenerator/GeneratedCounter.g.${extension}`,
        generatorProject: "Generator/Generator.csproj",
        generatorClass: "Example.OriginalGenerator",
      },
    ];
    const xml = await readFile(path.join(root, project.file), "utf8"),
      source = `${directory}/Counter.${extension}`,
      text = await readFile(path.join(root, source), "utf8");
    if (
      xml.split("</Project>").length !== 2 ||
      text.split("value + 1").length !== 2
    )
      throw Error("Unique original generator source/project anchors");
    edits.push(
      [
        project.file,
        xml.replace(
          "</Project>",
          '<ItemGroup><ProjectReference Include="../Generator/Generator.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" /></ItemGroup></Project>',
        ),
      ],
      [source, text.replace("value + 1", "GeneratedCounter.Advance(value)")],
    );
  }
  const policy = {
    schemaVersion: 1,
    profile: "compiled-method-and-project-reference-v1",
    projectReferences: config.projects
      .filter((p) => p.kind === "test")
      .map((p) => ({
        consumer: p.file,
        producer: config.projects.find(
          (q) => q.assemblyName === p.assemblyName.replace(/Tests$/, ""),
        )!.file,
        kind: "assembly",
      })),
    incrementalGenerators: [
      {
        project: "Generator/Generator.csproj",
        className: "Example.OriginalGenerator",
      },
    ],
  };
  for (const p of config.projects)
    for (const g of p.roslynGeneratedSources)
      if (
        !policy.projectReferences.some(
          (r) =>
            r.consumer === p.file &&
            r.producer === g.generatorProject &&
            r.kind === "analyzer",
        )
      )
        policy.projectReferences.push({
          consumer: p.file,
          producer: g.generatorProject,
          kind: "analyzer",
        });
  edits.push(
    [
      "Original.slnx",
      "<Solution>" +
        config.projects.map((p) => `<Project Path="${p.file}" />`).join("") +
        "</Solution>",
    ],
    ["checktrail.dotnet-build.json", JSON.stringify(config)],
    ["checktrail.dotnet-generator.json", JSON.stringify(policy)],
    [
      "checktrail.json",
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["dotnet.generator-extensions"] }],
      }),
    ],
  );
  await mkdir(path.join(root, "Generator"));
  for (const [file, text] of edits)
    await writeFile(path.join(root, file), text);
  return { root, config, policy };
}
export async function dotnetGeneratorMethodFixture(t: TestContext) {
  const data = await dotnetGeneratorExtensionsFixture(t),
    { root, config } = data;
  const source: Record<string, string> = {
    "CSharpTests/BaseCases.cs": String.raw`using NUnit.Framework; namespace Example;
public abstract class BaseCases {
 [TestCase(2)] public void Inherited(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));
}`,
    "CSharpTests/CounterTests.cs": String.raw`using NUnit.Framework; namespace Example;
[TestFixture] public sealed class CounterTests : BaseCases {
 public CounterTests() {}
 [TestCase(2, TestName="integer & literal")] public void Boundary(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));
 [TestCase("x", TestName="string < literal>")] public void Boundary(string value) => Assert.That(value, Is.EqualTo("x"));
 [TestCase(-1)] [TestCase(2)] public void Scale(int value) => Assert.That(Counter.Next(value), Is.EqualTo(value + 1));
}`,
    "FSharpTests/BaseCases.fs": String.raw`namespace Example
open NUnit.Framework
[<AbstractClass>]
type BaseCases() =
    [<TestCase(2)>]
    member _.Inherited(value: int) = Assert.That(Counter.next value, Is.EqualTo(value + 1))
`,
    "FSharpTests/CounterTests.fs": String.raw`namespace Example
open NUnit.Framework
[<TestFixture>]
type CounterTests() =
    inherit BaseCases()
    [<TestCase(2, TestName="integer & literal")>]
    member _.Boundary(value: int) = Assert.That(Counter.next value, Is.EqualTo(value + 1))
    [<TestCase("x", TestName="string < literal>")>]
    member _.Boundary(value: string) = Assert.That(value, Is.EqualTo("x"))
    [<TestCase(-1)>] [<TestCase(2)>]
    member _.Scale(value: int) = Assert.That(Counter.next value, Is.EqualTo(value + 1))
`,
    "VisualBasicTests/BaseCases.vb": String.raw`Imports NUnit.Framework
Namespace Example
Public MustInherit Class BaseCases
<TestCase(2)> Public Sub Inherited(value As Integer)
Assert.That(Counter.NextValue(value), [Is].EqualTo(value + 1))
End Sub
End Class
End Namespace`,
    "VisualBasicTests/CounterTests.vb": String.raw`Imports NUnit.Framework
Namespace Example
<TestFixture> Public NotInheritable Class CounterTests
Inherits BaseCases
Public Sub New()
End Sub
<TestCase(2, TestName:="integer & literal")> Public Sub Boundary(value As Integer)
Assert.That(Counter.NextValue(value), [Is].EqualTo(value + 1))
End Sub
<TestCase("x", TestName:="string < literal>")> Public Sub Boundary(value As String)
Assert.That(value, [Is].EqualTo("x"))
End Sub
<TestCase(-1), TestCase(2)> Public Sub Scale(value As Integer)
Assert.That(Counter.NextValue(value), [Is].EqualTo(value + 1))
End Sub
End Class
End Namespace`,
  };
  const fs = config.projects.find(
      (p) => p.language === "fsharp" && p.kind === "test",
    )!,
    xml = await readFile(path.join(root, fs.file), "utf8"),
    anchor = '<Compile Include="CounterTests.fs"/>';
  if (xml.split(anchor).length !== 2) throw Error("One F# source-order anchor");
  for (const p of config.projects.filter((p) => p.kind === "test")) {
    const extension =
      p.language === "csharp" ? "cs" : p.language === "fsharp" ? "fs" : "vb";
    p.sources.unshift(
      path.posix.join(path.posix.dirname(p.file), "BaseCases." + extension),
    );
  }
  for (const [file, text] of Object.entries(source))
    await writeFile(path.join(root, file), text);
  await writeFile(
    path.join(root, fs.file),
    xml.replace(anchor, '<Compile Include="BaseCases.fs"/>' + anchor),
  );
  await writeFile(
    path.join(root, "checktrail.dotnet-build.json"),
    JSON.stringify(config),
  );
  return data;
}

export function rewriteDotnetGeneratorPacket(
  process: ProcessResult,
  mutate: (
    packet: ReturnType<typeof dotnetGeneratorExtensionsPacketSchema.parse>,
  ) => void,
): ProcessResult {
  const packet = dotnetGeneratorExtensionsPacketSchema.parse(
    JSON.parse(process.stdout),
  );
  mutate(packet);
  return { ...process, stdout: JSON.stringify(packet) };
}
export function rewriteDotnetGeneratorNative(
  process: ProcessResult,
  mutate: (
    identity: NonNullable<
      ReturnType<
        typeof dotnetGeneratorExtensionsPacketSchema.parse
      >["generatorIdentity"]
    >,
  ) => void,
): ProcessResult {
  return rewriteDotnetGeneratorPacket(process, (packet) => {
    const identity = packet.generatorIdentity!;
    mutate(identity);
    const captures = [...identity.metadata, ...identity.discovery],
      receipts = packet.nativeReceipts.slice(-captures.length);
    for (const [i, capture] of captures.entries()) {
      capture.stdout = JSON.stringify(capture.native);
      receipts[i]!.stdoutBytes = Buffer.byteLength(capture.stdout);
      receipts[i]!.stdoutSha256 = mavenHash(capture.stdout);
    }
  });
}

export async function dotnetGeneratorCrossAssemblyFixture(t: TestContext) {
  const data = await dotnetGeneratorMethodFixture(t),
    { root, config } = data;
  const edits: Array<[string, string]> = [],
    removed: string[] = [];
  for (const tests of config.projects.filter((p) => p.kind === "test")) {
    const producer = config.projects.find(
      (p) => p.assemblyName === tests.assemblyName.replace(/Tests$/, ""),
    )!;
    const from = tests.sources.find((f) =>
        /\/BaseCases\.(?:cs|fs|vb)$/.test(f),
      )!,
      to = path.posix.join(
        path.posix.dirname(producer.file),
        path.posix.basename(from),
      );
    edits.push([to, await readFile(path.join(root, from), "utf8")]);
    removed.push(from);
    tests.sources = tests.sources.filter((f) => f !== from);
    producer.sources.push(to);
    const xml = await readFile(path.join(root, producer.file), "utf8");
    if (xml.split("</Project>").length !== 2)
      throw Error("One producer project anchor");
    let extended = xml.replace(
      "</Project>",
      '<ItemGroup><Reference Include="nunit.framework"><HintPath>$(RestorePackagesPath)/nunit/4.6.1/lib/net8.0/nunit.framework.dll</HintPath></Reference></ItemGroup></Project>',
    );
    if (tests.language === "fsharp") {
      const anchor = '<Compile Include="Counter.fs"/>';
      if (extended.split(anchor).length !== 2)
        throw Error("One producer F# source-order anchor");
      extended = extended.replace(
        anchor,
        anchor + '<Compile Include="BaseCases.fs"/>',
      );
      const testXml = await readFile(path.join(root, tests.file), "utf8"),
        base = '<Compile Include="BaseCases.fs"/>';
      if (testXml.split(base).length !== 2)
        throw Error("One consumer F# source-order anchor");
      edits.push([tests.file, testXml.replace(base, "")]);
    }
    edits.push([producer.file, extended]);
  }
  edits.push(["checktrail.dotnet-build.json", JSON.stringify(config)]);
  for (const [file, text] of edits)
    await writeFile(path.join(root, file), text);
  for (const file of removed) await rm(path.join(root, file));
  return data;
}
