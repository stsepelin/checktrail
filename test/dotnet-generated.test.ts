import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPlan, validate } from "../src/engine.js";
import { dotnetBuildConfigSchema } from "../src/dotnet-build.js";
import {
  dotnetBuildEvidence,
  dotnetBuildPacketSchema,
} from "../src/dotnet-build-evidence.js";
import {
  dotnetGeneratedFixture,
  originalGeneratorSource,
} from "./dotnet-generated-fixture.js";
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
const expect = (r: CheckResult, status: string) =>
  assert.equal(
    r.status,
    status,
    JSON.stringify({
      status: r.status,
      reason: r.reason,
      stderr: r.processes.map((p) => p.stderr.slice(0, 512)),
    }),
  );
test("Roslyn source-generator declarations reject foreign unknown and unbounded origins", () => {
  const project = {
    file: "Original.csproj",
    language: "csharp",
    assemblyName: "Original",
    targetFramework: "net10.0",
    kind: "library",
    sources: ["Original.cs"],
    generatedSources: [],
    testClasses: [],
  };
  const config = {
    schemaVersion: 1,
    solution: "Original.slnx",
    repository: "dependencies",
    repositoryManifest: "repository.json",
    repositorySha256: "a".repeat(64),
    projects: [project],
  };
  assert.deepEqual(
    dotnetBuildConfigSchema.parse(config).projects[0]!.roslynGeneratedSources,
    [],
  );
  for (const origin of [
    {
      file: "../foreign.cs",
      generatorProject: "Original.csproj",
      generatorClass: "Original.Generator",
    },
    {
      file: "obj/generated.cs",
      generatorProject: "/foreign.csproj",
      generatorClass: "Original.Generator",
    },
    {
      file: "obj/generated.cs",
      generatorProject: "Original.csproj",
      generatorClass: "Original/Generator",
    },
    {
      file: "obj/generated.cs",
      generatorProject: "Original.csproj",
      generatorClass: "Original.Generator",
      extra: true,
    },
  ])
    assert.equal(
      dotnetBuildConfigSchema.safeParse({
        ...config,
        projects: [{ ...project, roslynGeneratedSources: [origin] }],
      }).success,
      false,
    );
});
test(
  "native Roslyn planning retains invalid producers duplicate scope and unverified formatting without execution",
  native,
  async (t) => {
    const { root, config } = await dotnetGeneratedFixture(t),
      target = path.join(root, "checktrail.dotnet-build.json"),
      original = JSON.stringify(config);
    const changes: Array<(c: typeof config) => void> = [
      (c) => {
        c.projects[1]!.roslynGeneratedSources[0]!.generatorProject =
          c.projects[1]!.file;
      },
      (c) => {
        c.projects[1]!.roslynGeneratedSources[0]!.generatorProject =
          "OriginalMissing.csproj";
      },
      (c) => {
        c.projects[1]!.roslynGeneratedSources[0]!.file =
          c.projects[1]!.roslynGeneratedSources[0]!.file.replace(
            ".g.cs",
            ".g.vb",
          );
      },
      (c) => {
        c.projects[1]!.roslynGeneratedSources[0]!.file =
          c.projects[1]!.roslynGeneratedSources[0]!.file.replace(
            "Example.OriginalGenerator/",
            "Other.Generator/",
          );
      },
      (c) => {
        c.projects[1]!.roslynGeneratedSources.push(
          structuredClone(c.projects[1]!.roslynGeneratedSources[0]!),
        );
      },
      (c) => {
        c.projects[0]!.kind = "test";
      },
    ];
    for (const change of changes) {
      const changed = structuredClone(config);
      change(changed);
      await writeFile(target, JSON.stringify(changed));
      const check = (await createPlan(root)).plan.checks[0]!;
      assert.equal(check.commands.length, 0);
      const result = (await run(root)).checks[0]!;
      expect(result, "unavailable");
      assert.equal(result.processes.length, 0);
    }
    await writeFile(target, original);
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["dotnet.format-whitespace"] }],
      }),
    );
    const formatting = (await createPlan(root)).plan.checks[0]!;
    assert.equal(formatting.commands.length, 0);
    assert.match(formatting.unavailableReason!, /generator outputs/);
    const result = (await run(root)).checks[0]!;
    expect(result, "unavailable");
    assert.equal(result.processes.length, 0);
    assert.ok(result.scope.includes("Generator/OriginalGenerator.cs"));
  },
);
test(
  "native Roslyn C# and VB outputs participate in compilation symbols and repaired consumer boundary tests",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t, "dotnet.test"),
      initial = (await run(root)).checks[0]!;
    expect(initial, "passed");
    assert.deepEqual(initial.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.equal(initial.findingsComplete, true);
    const data = JSON.parse(initial.processes[0]!.stdout).build;
    assert.equal(data.modules.length, 5);
    assert.equal(data.generatedSources.length, 2);
    assert.deepEqual(
      data.generatedSources.map((g: { project: string }) => g.project).sort(),
      ["CSharp/CSharp.csproj", "VisualBasic/VisualBasic.vbproj"],
    );
    const file = path.join(root, "Generator/OriginalGenerator.cs"),
      original = await readFile(file, "utf8");
    assert.equal(original.split("=> value + 1;").length, 2);
    try {
      await writeFile(
        file,
        original.replace("=> value + 1;", "=> value < 0 ? value : value + 1;"),
      );
      const broken = (await run(root)).checks[0]!;
      expect(broken, "failed");
      assert.deepEqual(broken.tests, {
        total: 4,
        passed: 3,
        failed: 1,
        skipped: 0,
      });
      assert.equal(broken.findingsComplete, true);
      assert.deepEqual(
        broken.findings
          ?.filter((f) => f.ruleId === "dotnet-test/case-failure")
          .map((f) => f.file),
        ["CSharpTests/CounterTests.cs"],
      );
    } finally {
      await writeFile(file, original);
    }
    const repaired = (await run(root)).checks[0]!;
    expect(repaired, "passed");
    assert.deepEqual(repaired.tests, initial.tests);
  },
);
test(
  "native Roslyn packets reject omitted forged stale disabled and source-unbound generator evidence",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t),
      check = (await createPlan(root)).plan.checks[0]!,
      result = (await run(root)).checks[0]!;
    expect(result, "passed");
    const process = result.processes[0]!,
      baseline = dotnetBuildPacketSchema.parse(JSON.parse(process.stdout));
    type Packet = typeof baseline;
    const controls: Array<[string, (d: Packet) => void]> = [];
    const add = (name: string, change: (d: Packet) => void) =>
      controls.push([name, change]);
    const source = (d: Packet) => d.generatedSources[0]!,
      producer = (d: Packet) =>
        d.modules.find((m) => m.file === "Generator/Generator.csproj")!,
      consumer = (d: Packet) =>
        d.modules.find((m) => m.file === source(d).project)!;
    const parameter = (d: Packet, name: string) => {
      const start = d.events.find(
        (e) =>
          e.type === "compilerStarted" &&
          e.file === path.join(d.workspace, source(d).project),
      )!;
      return d.events.find(
        (e) =>
          e.type === "parameter" &&
          e.name === name &&
          JSON.stringify(e.context) === JSON.stringify(start.context),
      )!;
    };
    add("omitted generated source", (d) => {
      d.generatedSources.pop();
    });
    add("duplicate generated source", (d) => {
      d.generatedSources.push(structuredClone(source(d)));
    });
    add("foreign generated source", (d) => {
      source(d).file = "/foreign/Generated.cs";
    });
    add("foreign producer", (d) => {
      source(d).generatorProject = "Foreign.csproj";
    });
    add("foreign generator class", (d) => {
      source(d).generatorClass = "Foreign.Generator";
    });
    add("foreign producer assembly", (d) => {
      source(d).producerAssembly = "/foreign/Generator.dll";
    });
    add("foreign producer bytes", (d) => {
      source(d).producerAssemblySha256 = "0".repeat(64);
    });
    add("foreign generated bytes", (d) => {
      source(d).sha256 = "0".repeat(64);
    });
    add("foreign generated size", (d) => {
      source(d).bytes++;
    });
    add("foreign generated SHA1", (d) => {
      source(d).sha1 = "0".repeat(40);
    });
    add("missing generated source pin", (d) => {
      d.compiledSources = d.compiledSources.filter(
        (s) => s.file !== source(d).file,
      );
    });
    add("missing consumer symbols", (d) => {
      consumer(d).metadata!.documents = consumer(d).metadata!.documents.filter(
        (s) => s.file !== source(d).file,
      );
    });
    add("foreign generated symbol checksum", (d) => {
      consumer(d).metadata!.documents.find(
        (s) => s.file === source(d).file,
      )!.hash = "0".repeat(64);
    });
    add("missing generator contract", (d) => {
      producer(d).metadata!.types.find(
        (v) => v.className === source(d).generatorClass,
      )!.interfaces = [];
    });
    add("foreign generator initializer source", (d) => {
      producer(d)
        .metadata!.types.find((v) => v.className === source(d).generatorClass)!
        .methods.find((m) => m.name === "Initialize")!.files = [
        "/foreign/Generator.cs",
      ];
    });
    add("missing native generator analyzer", (d) => {
      parameter(d, "Analyzers").values = (
        parameter(d, "Analyzers").values as string[]
      ).filter((f) => !f.endsWith("/Original.Generator.dll"));
    });
    add("disabled native emission", (d) => {
      const e = d.events.find(
        (e) =>
          e.type === "evaluation" &&
          e.file === path.join(d.workspace, source(d).project),
      )!;
      (e.properties as Record<string, string>).EmitCompilerGeneratedFiles =
        "false";
    });
    add("foreign native output directory", (d) => {
      parameter(d, "GeneratedFilesOutputPath").values = ["obj/Foreign"];
    });
    add("missing native producer observation", (d) => {
      d.observedArtifacts = d.observedArtifacts.filter(
        (p) => p.file !== source(d).producerAssembly,
      );
    });
    for (const [name, change] of controls) {
      const packet = structuredClone(baseline);
      change(packet);
      const parsed = dotnetBuildEvidence(check, [
        { ...process, stdout: JSON.stringify(packet) },
      ]);
      assert.equal(parsed.status, "inconclusive", name);
      assert.equal(parsed.findingsComplete, false, name);
    }
    assert.equal(dotnetBuildEvidence(check, [process]).status, "passed");
    assert.equal(dotnetBuildEvidence(check, []).status, "inconclusive");
  },
);
test(
  "native Roslyn missing extra and throwing outputs cannot pass and preserve caller-owned generated files",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t),
      file = path.join(root, "Generator/OriginalGenerator.cs"),
      original = await readFile(file, "utf8"),
      sentinel = path.join(
        root,
        "CSharp/obj/Debug/net10.0/generated/caller.keep",
      );
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "original caller-owned output");
    const controls: readonly (readonly [string, string])[] = [
      [
        "missing output",
        original.replace(
          'output.AddSource(cs?"GeneratedCounter.g.cs":"GeneratedCounter.g.vb",SourceText.From(source,Encoding.UTF8));',
          "// Original emission intentionally omitted.",
        ),
      ],
      [
        "extra sibling",
        original.replace(
          "output.ReportDiagnostic(",
          'output.AddSource(cs?"Extra.g.cs":"Extra.g.vb",SourceText.From(cs?"namespace Example { public class Extra {} }":"Namespace Example\\nPublic Class Extra\\nEnd Class\\nEnd Namespace",Encoding.UTF8));\n   output.ReportDiagnostic(',
        ),
      ],
      [
        "throwing generator",
        original.replace(
          "var cs=compilation.Language==LanguageNames.CSharp;",
          'throw new System.InvalidOperationException("Original synthetic generator failure");\n   var cs=compilation.Language==LanguageNames.CSharp;',
        ),
      ],
    ];
    try {
      for (const [name, source] of controls) {
        await writeFile(file, source);
        const failed = (await run(root)).checks[0]!;
        assert.notEqual(failed.status, "passed", name);
        assert.equal(failed.findingsComplete, false, name);
        if (name === "extra sibling") {
          expect(failed, "inconclusive");
          assert.match(failed.reason, /Native Roslyn emitted sources/);
          const scope = JSON.parse(failed.processes[0]!.stdout);
          assert.equal(
            scope.generatedScopeFailure,
            "native-output-declaration",
          );
          assert.equal(scope.buildExitCode, 0);
          assert.equal(
            scope.nativeReceipts.find(
              (r: { phase: string }) => r.phase === "build",
            ).exitCode,
            0,
          );
        } else {
          expect(failed, "failed");
          assert.ok(
            failed.findings?.some(
              (f) =>
                f.ruleId === "dotnet-build/CS0103" &&
                f.file === "CSharp/Counter.cs",
            ),
            name,
          );
          if (name === "throwing generator")
            assert.ok(
              failed.findings?.some((f) => f.ruleId === "dotnet-build/CS8785"),
              "Native generator exception diagnostic is retained",
            );
        }
        assert.deepEqual(
          await readFile(sentinel, "utf8"),
          "original caller-owned output",
        );
      }
    } finally {
      await writeFile(file, original);
    }
    expect((await run(root)).checks[0]!, "passed");
    await assert.rejects(access(path.join(root, "Generator/bin")));
  },
);
test(
  "native Roslyn producer source errors retain the actual diagnostic and valid interface spelling near misses compile",
  native,
  async (t) => {
    const { root } = await dotnetGeneratedFixture(t),
      file = path.join(root, "Generator/OriginalGenerator.cs");
    try {
      await writeFile(
        file,
        originalGeneratorSource.replace(
          "SourceText.From(source,Encoding.UTF8)",
          "OriginalMissingSymbol",
        ),
      );
      const failed = (await run(root)).checks[0]!;
      expect(failed, "failed");
      assert.equal(failed.findingsComplete, false);
      assert.ok(
        failed.findings?.some(
          (f) =>
            f.ruleId === "dotnet-build/CS0103" &&
            f.file === "Generator/OriginalGenerator.cs" &&
            f.line! > 0,
        ),
      );
      await writeFile(
        file,
        originalGeneratorSource.replace(
          " : IIncrementalGenerator",
          " : Microsoft.CodeAnalysis.IIncrementalGenerator",
        ),
      );
      expect((await run(root)).checks[0]!, "passed");
      const initialization =
        "public void Initialize(IncrementalGeneratorInitializationContext context) {\n  context.RegisterSourceOutput(context.CompilationProvider,(output,compilation)=>{";
      assert.equal(originalGeneratorSource.split(initialization).length, 2);
      assert.equal(originalGeneratorSource.split("  });\n }").length, 2);
      const classic = originalGeneratorSource
        .replace(": IIncrementalGenerator", ": ISourceGenerator")
        .replace(
          initialization,
          "public void Initialize(GeneratorInitializationContext context) { System.GC.KeepAlive(context); }\n public void Execute(GeneratorExecutionContext output) {\n  var compilation = output.Compilation;",
        )
        .replace("  });\n }", " }");
      await writeFile(file, classic);
      expect((await run(root)).checks[0]!, "passed");
    } finally {
      await writeFile(file, originalGeneratorSource);
    }
  },
);
