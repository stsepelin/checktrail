import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import { selectedDotnetFormatterSdk } from "../src/dotnet-format-extensions.js";
import {
  dotnetFormatExtensionsPacketSchema,
  dotnetFormatExtensionsNativeSchema,
} from "../src/dotnet-format-extensions-contract.js";
import { captureProcessOutput } from "../src/process-output.js";
import type { ProcessResult, Report } from "../src/types.js";
const available =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  (await selectedDotnetFormatterSdk().then(
    () => true,
    () => false,
  ));
export const dotnetFormattingNative = {
  skip: available
    ? false
    : "The selected Linux ARM64 SDK/runtime formatting components are unavailable",
  timeout: 240000,
};
export const dotnetFormattingPolicy = {
  schemaVersion: 1,
  profile: "sdk-code-style-and-analyzers-v1",
  styleDiagnostics: ["IDE0005", "IDE0007"],
  analyzerDiagnostics: ["CA1822"],
  severity: "info",
  includeGenerated: true,
} as const;
const editor =
  "root = true\n[*.{cs,vb}]\ndotnet_diagnostic.IDE0005.severity = warning\ndotnet_diagnostic.IDE0007.severity = warning\ndotnet_diagnostic.CA1822.severity = warning\ncsharp_style_var_for_built_in_types = true:warning\ncsharp_style_var_when_type_is_apparent = true:warning\ncsharp_style_var_elsewhere = true:warning\n[*.g.{cs,vb}]\ngenerated_code = false\n";
const xmlText = (value: string) =>
  value
    .replaceAll("%", "%25")
    .replaceAll(";", "%3B")
    .replaceAll("\n", "%0A")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
export function dotnetFormattingFiles(mode: "broken" | "fixed" | "near-miss") {
  const fixed = mode !== "broken";
  const csharp = `${fixed ? "" : "using System.Text;\n\n"}namespace Original;\n\npublic class Counter\n{\n${mode === "near-miss" ? "    private readonly int _value = 1;\n\n" : ""}    public ${mode === "near-miss" || !fixed ? "" : "static "}${fixed ? "int" : " int"} Value()\n    {\n        ${fixed ? "var" : "int"} number = 1;\n        return ${mode === "near-miss" ? "_value + " : ""}number;\n    }\n}\n`;
  const vb = `${fixed ? "" : "Imports System.Text\n\n"}Namespace Original\n    Public Class Counter\n${mode === "near-miss" ? "        Private ReadOnly _value As Integer = 1\n\n" : ""}        Public ${mode === "near-miss" || !fixed ? "" : "Shared "}Function Value() As Integer\n            Return ${mode === "near-miss" ? "_value + " : ""}1\n        End Function\n    End Class\nEnd Namespace\n`;
  const generatedCs = `namespace Original\n{\n    public class GeneratedCounter\n    {\n        public ${fixed ? "static " : ""}${fixed ? "int" : " int"} Value() => 4;\n    }\n}\n`;
  const generatedVb = `Namespace Original\n    Public Class GeneratedCounter\n        Public ${fixed ? "Shared " : ""}${fixed ? "Function" : " Function"} Value() As Integer\n            Return 4\n        End Function\n    End Class\nEnd Namespace\n`;
  const msbuild = `namespace Original\n{\n    public class MsbuildGenerated\n    {\n        public ${fixed ? "static " : ""}${fixed ? "int" : " int"} Value() => 2;\n    }\n}\n`;
  const generator = `using Microsoft.CodeAnalysis;\n\nnamespace Original;\n\n[Generator(LanguageNames.CSharp, LanguageNames.VisualBasic)]\npublic sealed class OriginalGenerator : IIncrementalGenerator\n{\n    public void Initialize(IncrementalGeneratorInitializationContext context)\n    {\n        context.RegisterSourceOutput(context.CompilationProvider, (output, compilation) =>\n        {\n            var csharp = compilation.Language == LanguageNames.CSharp;\n            var text = csharp ? ${JSON.stringify(generatedCs)} : ${JSON.stringify(generatedVb)};\n            output.AddSource(csharp ? "GeneratedCounter.g.cs" : "GeneratedCounter.g.vb", text);\n        });\n    }\n}\n`;
  const properties =
    "<TargetFramework>net10.0</TargetFramework><RestorePackagesWithLockFile>true</RestorePackagesWithLockFile><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation><RootNamespace></RootNamespace><EnableNETAnalyzers>true</EnableNETAnalyzers><AnalysisLevel>latest-all</AnalysisLevel>";
  const reference =
    '<ItemGroup><ProjectReference Include="../Generator/Generator.csproj" OutputItemType="Analyzer" ReferenceOutputAssembly="false"/></ItemGroup>';
  return {
    "Original.slnx":
      '<Solution><Project Path="CSharp/CSharp.csproj"/><Project Path="VisualBasic/VisualBasic.vbproj"/><Project Path="Generator/Generator.csproj"/></Solution>',
    "CSharp/CSharp.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${properties}<AssemblyName>Original.CSharp</AssemblyName></PropertyGroup>${reference}<Target Name="OriginalGeneration" BeforeTargets="CoreCompile"><WriteLinesToFile File="$(IntermediateOutputPath)Original.Generated.g.cs" Lines="${xmlText(msbuild)}" Overwrite="true"/><ItemGroup><Compile Include="$(IntermediateOutputPath)Original.Generated.g.cs"/></ItemGroup></Target></Project>`,
    "VisualBasic/VisualBasic.vbproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${properties}<AssemblyName>Original.VisualBasic</AssemblyName></PropertyGroup>${reference}</Project>`,
    "Generator/Generator.csproj": `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${properties}<AssemblyName>Original.Generator</AssemblyName></PropertyGroup><ItemGroup><Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildToolsPath)/Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference></ItemGroup></Project>`,
    "CSharp/Counter.cs": csharp,
    "VisualBasic/Counter.vb": vb,
    "Generator/OriginalGenerator.cs": generator,
    ...Object.fromEntries(
      ["CSharp", "VisualBasic", "Generator"].map((p) => [
        p + "/packages.lock.json",
        JSON.stringify({ version: 1, dependencies: { "net10.0": {} } }),
      ]),
    ),
    ".editorconfig": editor,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["dotnet.format-extensions"] }],
    }),
    "checktrail.dotnet-format.json": JSON.stringify(dotnetFormattingPolicy),
  };
}
export async function dotnetFormattingFixture(
  t: TestContext,
  mode: "broken" | "fixed" | "near-miss" = "broken",
) {
  const sentinel = "Original local dependency closure marker\n",
    pins = JSON.stringify({
      schemaVersion: 1,
      files: [
        {
          path: "original-marker.txt",
          bytes: Buffer.byteLength(sentinel),
          sha256: mavenHash(sentinel),
        },
      ],
    });
  const projects = [
    {
      file: "CSharp/CSharp.csproj",
      language: "csharp",
      assemblyName: "Original.CSharp",
      sources: ["CSharp/Counter.cs"],
      generatedSources: ["CSharp/obj/Debug/net10.0/Original.Generated.g.cs"],
      roslynGeneratedSources: [
        {
          file: "CSharp/obj/Debug/net10.0/generated/Original.Generator/Original.OriginalGenerator/GeneratedCounter.g.cs",
          generatorProject: "Generator/Generator.csproj",
          generatorClass: "Original.OriginalGenerator",
        },
      ],
    },
    {
      file: "VisualBasic/VisualBasic.vbproj",
      language: "visual-basic",
      assemblyName: "Original.VisualBasic",
      sources: ["VisualBasic/Counter.vb"],
      generatedSources: [],
      roslynGeneratedSources: [
        {
          file: "VisualBasic/obj/Debug/net10.0/generated/Original.Generator/Original.OriginalGenerator/GeneratedCounter.g.vb",
          generatorProject: "Generator/Generator.csproj",
          generatorClass: "Original.OriginalGenerator",
        },
      ],
    },
    {
      file: "Generator/Generator.csproj",
      language: "csharp",
      assemblyName: "Original.Generator",
      sources: ["Generator/OriginalGenerator.cs"],
      generatedSources: [],
      roslynGeneratedSources: [],
    },
  ].map((p) => ({
    ...p,
    targetFramework: "net10.0",
    kind: "library",
    testClasses: [],
  }));
  return fixture(t, {
    ...dotnetFormattingFiles(mode),
    ".checktrail/repository/original-marker.txt": sentinel,
    ".checktrail/repository.json": pins,
    "checktrail.dotnet-build.json": JSON.stringify({
      schemaVersion: 1,
      solution: "Original.slnx",
      repository: ".checktrail/repository",
      repositoryManifest: ".checktrail/repository.json",
      repositorySha256: mavenHash(pins),
      projects,
    }),
  });
}
export async function repairDotnetFormatting(root: string) {
  for (const [file, text] of Object.entries(dotnetFormattingFiles("fixed")))
    await writeFile(path.join(root, file), text);
}
export function dotnetFormattingPacket(report: Report) {
  return dotnetFormatExtensionsPacketSchema.parse(
    JSON.parse(report.checks[0]!.processes[0]!.stdout),
  );
}
export function dotnetFormattingObservation(report: Report) {
  return dotnetFormatExtensionsNativeSchema.parse(
    JSON.parse(dotnetFormattingPacket(report).extensions!.phases[1]!.stdout),
  );
}
export function rewriteDotnetFormattingNative(
  process: ProcessResult,
  change: (
    native: ReturnType<typeof dotnetFormatExtensionsNativeSchema.parse>,
  ) => void,
) {
  const result = structuredClone(process),
    packet = dotnetFormatExtensionsPacketSchema.parse(
      JSON.parse(result.stdout),
    ),
    f = packet.extensions!,
    native = dotnetFormatExtensionsNativeSchema.parse(
      JSON.parse(f.phases[1]!.stdout),
    );
  change(native);
  const phase = f.phases[1]!;
  phase.stdout = JSON.stringify(native);
  phase.stdoutBytes = Buffer.byteLength(phase.stdout);
  phase.stdoutSha256 = mavenHash(phase.stdout);
  f.completed.observationSha256 = mavenHash(phase.stdout);
  f.completed.allDocuments = native.allDocuments;
  f.completed.phases = native.phases.map((p) => ({
    mode: p.mode,
    documents: p.documents.length,
    diagnostics: p.diagnostics.length,
    reportRows: p.sdkReport.length,
    changedDocuments: p.documents.filter((d) => d.changed).length,
  }));
  phase.capturedOutput = captureProcessOutput(
    Buffer.from(phase.stdout),
    Buffer.from(phase.stderr),
    phase.stdoutBytes + phase.stderrBytes,
    true,
  );
  result.stderr = f.phases[0]!.stdout + phase.stdout;
  f.mirroredBytes = Buffer.byteLength(result.stderr);
  f.mirroredSha256 = mavenHash(result.stderr);
  result.stdout = JSON.stringify(packet);
  return result;
}
export async function sourceDotnetFormattingBytes(root: string) {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(dotnetFormattingFiles("broken")).map(async (file) => [
        file,
        mavenHash(await readFile(path.join(root, file))),
      ]),
    ),
  );
}

export function rewriteDotnetFormattingPacket(
  process: ProcessResult,
  change: (
    packet: ReturnType<typeof dotnetFormatExtensionsPacketSchema.parse>,
  ) => void,
) {
  const result = structuredClone(process),
    packet = dotnetFormatExtensionsPacketSchema.parse(
      JSON.parse(result.stdout),
    );
  change(packet);
  result.stdout = JSON.stringify(packet);
  return result;
}
