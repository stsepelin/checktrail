import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { dotnetFormatFixture } from "./dotnet-format-fixture.js";
export const originalGeneratorSource = String.raw`using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
namespace Example;
[Generator(LanguageNames.CSharp, LanguageNames.VisualBasic)]
public sealed class OriginalGenerator : IIncrementalGenerator {
 public void Initialize(IncrementalGeneratorInitializationContext context) {
  context.RegisterSourceOutput(context.CompilationProvider,(output,compilation)=>{
   var cs=compilation.Language==LanguageNames.CSharp;
   var source=cs ? "namespace Example { public static class GeneratedCounter { public static int Advance(int value) => value + 1; } }" : "Namespace Example\nPublic Module GeneratedCounter\nPublic Function Advance(value As Integer) As Integer\nReturn value + 1\nEnd Function\nEnd Module\nEnd Namespace";
   output.AddSource(cs?"GeneratedCounter.g.cs":"GeneratedCounter.g.vb",SourceText.From(source,Encoding.UTF8));
   output.ReportDiagnostic(Diagnostic.Create(new DiagnosticDescriptor("CTGEN001","Original generator","Original generator reached "+compilation.Language,"Original",DiagnosticSeverity.Warning,true),Location.None));
  });
 }
}
`;
export async function dotnetGeneratedFixture(
  t: TestContext,
  check = "dotnet.build",
) {
  const { root, config } = await dotnetFormatFixture(t);
  const edits: Array<[string, string]> = [];
  edits.push([
    path.join(root, "Generator/Generator.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>Original.Generator</AssemblyName><Nullable>enable</Nullable><RestorePackagesWithLockFile>true</RestorePackagesWithLockFile><EnableNETAnalyzers>true</EnableNETAnalyzers></PropertyGroup><ItemGroup><Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference></ItemGroup></Project>`,
  ]);
  edits.push([
    path.join(root, "Generator/packages.lock.json"),
    JSON.stringify({ version: 1, dependencies: { "net10.0": {} } }),
  ]);
  edits.push([
    path.join(root, "Generator/OriginalGenerator.cs"),
    originalGeneratorSource,
  ]);
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
  for (const [directory, extension] of [
    ["CSharp", "cs"],
    ["VisualBasic", "vb"],
  ]) {
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
    const file = path.join(root, project.file),
      xml = await readFile(file, "utf8");
    if (xml.split("</Project>").length !== 2)
      throw Error("One original generator reference anchor");
    edits.push([
      file,
      xml.replace(
        "</Project>",
        '<ItemGroup><ProjectReference Include="../Generator/Generator.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false" /></ItemGroup></Project>',
      ),
    ]);
    const source = path.join(root, directory!, "Counter." + extension),
      text = await readFile(source, "utf8");
    if (text.split("value + 1").length !== 2)
      throw Error("One original generated-call anchor");
    edits.push([
      source,
      text.replace("value + 1", "GeneratedCounter.Advance(value)"),
    ]);
  }
  edits.push([
    path.join(root, "Original.slnx"),
    "<Solution>" +
      config.projects.map((p) => `<Project Path="${p.file}" />`).join("") +
      "</Solution>",
  ]);
  edits.push([
    path.join(root, "checktrail.dotnet-build.json"),
    JSON.stringify(config),
  ]);
  edits.push([
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: [check] }],
    }),
  ]);
  await mkdir(path.join(root, "Generator"));
  for (const [file, text] of edits) await writeFile(file, text);
  return { root, config };
}
