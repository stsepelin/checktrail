import path from "node:path";
import { z } from "zod";
import {
  dotnetBuildInvocationSchema,
  dotnetBuildRepositorySchema,
} from "./dotnet-build.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  string = z.string().max(65536),
  file = z.string().min(1).max(8192);
const eventSchema = z
  .object({
    type: z.enum([
      "init",
      "evaluation",
      "projectStarted",
      "projectFinished",
      "compilerStarted",
      "compilerFinished",
      "compilerCommand",
      "parameter",
      "diagnostic",
      "finished",
      "close",
    ]),
  })
  .catchall(z.unknown());
const metadataSchema = z.strictObject({
  assemblyName: file,
  documents: z
    .array(
      z.strictObject({
        file,
        algorithm: file,
        hash: z
          .string()
          .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
          .or(z.literal("")),
      }),
    )
    .max(4096),
  types: z
    .array(
      z.strictObject({
        className: file,
        interfaces: z.array(file).max(256).default([]),
        methods: z
          .array(z.strictObject({ name: file, files: z.array(file).max(4096) }))
          .max(20000),
      }),
    )
    .max(4096),
});
export const dotnetBuildPacketSchema = z.strictObject({
  version: z.literal(1),
  inputSha256: digest,
  repositoryManifest: z
    .string()
    .min(1)
    .max(1024 * 1024),
  sdkVersion: z.literal("10.0.401"),
  runtimeVersion: z.literal("10.0.12"),
  sdk: file,
  workspace: file,
  launcherPid: z.number().int().positive(),
  restoreExitCode: z.literal(0),
  buildExitCode: z.number().int().min(0).max(255),
  restoreEvents: z.array(eventSchema).min(1).max(20000),
  events: z.array(eventSchema).min(1).max(20000),
  modules: z
    .array(
      z.strictObject({
        file,
        assembly: file,
        pdb: file,
        metadata: metadataSchema.nullable(),
      }),
    )
    .min(1)
    .max(64),
  nativeReceipts: z
    .array(
      z.strictObject({
        phase: file,
        exitCode: z.number().int().min(0).max(255),
        stdoutBytes: z
          .number()
          .int()
          .nonnegative()
          .max(1024 * 1024),
        stderrBytes: z
          .number()
          .int()
          .nonnegative()
          .max(1024 * 1024),
        stdoutSha256: digest,
        stderrSha256: digest,
        durationMs: z.number().int().nonnegative(),
      }),
    )
    .min(5)
    .max(80),
  observedArtifacts: z
    .array(
      z.strictObject({
        file,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(64 * 1024 * 1024),
        sha256: digest,
      }),
    )
    .min(1)
    .max(4096),
  observerSha256: digest,
  generatedSources: z
    .array(
      z.strictObject({
        project: file,
        file,
        generatorProject: file,
        generatorClass: file,
        producerAssembly: file,
        producerAssemblySha256: digest,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(4 * 1024 * 1024),
        sha256: digest,
        sha1: z.string().regex(/^[a-f0-9]{40}$/),
      }),
    )
    .max(4096)
    .default([]),
  compiledSources: z
    .array(
      z.strictObject({
        file,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(4 * 1024 * 1024),
        sha256: digest,
        sha1: z.string().regex(/^[a-f0-9]{40}$/),
      }),
    )
    .max(4096),
});
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const address = (base: string, value: string) =>
  path.resolve(base, value.replaceAll("\\", "/"));
const contextSchema = z.strictObject({
  node: z.number().int(),
  project: z.number().int(),
  target: z.number().int(),
  task: z.number().int(),
});
const contextKey = (value: unknown) =>
  JSON.stringify(contextSchema.parse(value));
const compilerNames = {
  csharp: "Csc",
  fsharp: "Fsc",
  "visual-basic": "Vbc",
} as const;
const extensions = {
  csharp: "cs",
  fsharp: "fs",
  "visual-basic": "vb",
} as const;
export function dotnetBuildEvidence(
  check: Check,
  processes: ProcessResult[],
  additionalSdkAnalyzerConfigs: ReadonlyMap<
    string,
    { bytes: number; sha256: string }
  > = new Map(),
  nativeMappedDocuments: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Pick<CheckResult, "status" | "reason" | "findingsComplete" | "findings"> {
  const incomplete = {
    status: "inconclusive" as const,
    findingsComplete: false,
    reason:
      ".NET evidence does not reconcile locked dependencies, every native compiler input and fresh outputs",
  };
  if (processes.length !== 1) return incomplete;
  const process = processes[0]!;
  if (process.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("dotnet-build-toolchain"),
      }).parse(JSON.parse(process.stdout));
      return {
        status: "unavailable",
        reason: "The pinned .NET SDK/compiler is unavailable",
      };
    } catch {
      return incomplete;
    }
  }
  if (process.exitCode !== 0)
    return {
      status: "error",
      findingsComplete: false,
      reason: ".NET native build evidence collection did not complete",
    };
  let sourceFailure = false;
  const findings: Finding[] = [];
  try {
    const raw = JSON.parse(process.stdout);
    if (raw.generatedScopeFailure === "native-output-declaration") {
      const scope = z
        .strictObject({
          version: z.literal(1),
          generatedScopeFailure: z.literal("native-output-declaration"),
          buildExitCode: z.literal(0),
          nativeReceipts: z
            .array(dotnetBuildPacketSchema.shape.nativeReceipts.element)
            .min(5)
            .max(80),
        })
        .parse(raw);
      requireEvidence(
        scope.nativeReceipts.filter((r) => r.phase === "build").length === 1 &&
          scope.nativeReceipts.find((r) => r.phase === "build")!.exitCode === 0,
        "Native build completed before generated-output scope reconciliation",
      );
      return {
        ...incomplete,
        reason:
          "Native Roslyn emitted sources do not match every declared output",
      };
    }
    if (raw.prerequisiteFailure === "locked-offline-restore") {
      z.strictObject({
        version: z.literal(1),
        prerequisiteFailure: z.literal("locked-offline-restore"),
        restoreExitCode: z.number().int().min(1).max(255),
        nativeReceipts: z
          .array(dotnetBuildPacketSchema.shape.nativeReceipts.element)
          .min(4)
          .max(80),
      }).parse(raw);
      return {
        status: "unavailable",
        findingsComplete: false,
        reason: "The locked offline .NET dependency restore did not complete",
      };
    }
    const data = dotnetBuildPacketSchema.parse(raw),
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      temporary = path.dirname(data.workspace),
      repository = path.join(temporary, "repository"),
      declared = invocation.config.projects;
    requireEvidence(
      data.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Current .NET source receipt",
    );
    requireEvidence(
      Buffer.byteLength(data.repositoryManifest) <= 1024 * 1024 &&
        mavenHash(data.repositoryManifest) ===
          invocation.config.repositorySha256,
      "Pinned .NET dependency manifest receipt",
    );
    const pins = dotnetBuildRepositorySchema.parse(
      JSON.parse(data.repositoryManifest),
    );
    requireEvidence(
      new Set(pins.files.map((item) => item.path)).size === pins.files.length,
      "Unique dependency identities",
    );
    requireEvidence(
      path.isAbsolute(data.workspace) &&
        path.basename(data.workspace) === "workspace" &&
        path.isAbsolute(data.sdk) &&
        path.basename(data.sdk) === "10.0.401",
      "Fresh .NET workspace and selected SDK",
    );
    requireEvidence(
      same(
        check.scope,
        declared.flatMap((item) => item.sources),
      ) &&
        same(
          check.scope,
          invocation.inputs
            .filter((item) => /\.(?:cs|fs|vb)$/.test(item.path))
            .map((item) => item.path),
        ),
      "Complete planned .NET source scope",
    );
    requireEvidence(
      same(
        data.modules.map((item) => item.file),
        declared.map((item) => item.file),
      ),
      "Every declared output module",
    );
    requireEvidence(
      new Set(data.observedArtifacts.map((item) => item.file)).size ===
        data.observedArtifacts.length &&
        new Set(data.compiledSources.map((item) => item.file)).size ===
          data.compiledSources.length,
      "Unique observed inputs",
    );
    for (const events of [data.restoreEvents, data.events]) {
      requireEvidence(
        events[0]!.type === "init" &&
          events.at(-1)!.type === "close" &&
          events.filter((event) => event.type === "init").length === 1 &&
          events.filter((event) => event.type === "close").length === 1 &&
          events.filter((event) => event.type === "finished").length === 1,
        "Complete native MSBuild lifecycle",
      );
      requireEvidence(
        events[0]!.framework ===
          path.join(data.sdk, "Microsoft.Build.Framework.dll") &&
          events[0]!.runtime === "10.0.12",
        "Native framework and runtime identity",
      );
    }
    requireEvidence(
      data.events[0]!.processId === data.launcherPid,
      "Owned native MSBuild client",
    );
    requireEvidence(
      data.restoreEvents.find((event) => event.type === "finished")!.success ===
        true,
      "Completed locked restore",
    );
    const starts = data.events.filter(
        (event) => event.type === "compilerStarted",
      ),
      ends = data.events.filter((event) => event.type === "compilerFinished"),
      diagnostics = data.events.filter((event) => event.type === "diagnostic");
    requireEvidence(
      starts.every((event) =>
        declared.some(
          (item) => event.file === path.join(data.workspace, item.file),
        ),
      ),
      "No foreign compiled project",
    );
    requireEvidence(
      new Set(starts.map((event) => contextKey(event.context))).size ===
        starts.length &&
        same(
          starts.map((event) => contextKey(event.context)),
          ends.map((event) => contextKey(event.context)),
        ),
      "Every compiler terminal",
    );
    for (const start of starts) {
      const item = declared.find(
          (item) => path.join(data.workspace, item.file) === start.file,
        )!,
        key = contextKey(start.context),
        end = ends.find((event) => contextKey(event.context) === key)!;
      requireEvidence(
        start.name === compilerNames[item.language] &&
          end.name === start.name &&
          end.file === start.file &&
          data.events.indexOf(start) < data.events.indexOf(end),
        "Native compiler identity and order",
      );
      const expectedAssembly = path.join(
        data.sdk,
        item.language === "fsharp"
          ? "FSharp/FSharp.Build.dll"
          : "Roslyn/Microsoft.Build.Tasks.CodeAnalysis.dll",
      );
      requireEvidence(
        start.assembly === expectedAssembly &&
          data.observedArtifacts.some((pin) => pin.file === expectedAssembly),
        "Selected native compiler task assembly",
      );
      const errors = diagnostics.filter(
        (event) =>
          event.severity === "error" &&
          event.project === start.file &&
          /^(?:CS|FS|BC|CA|IDE)\d+$/.test(String(event.code)) &&
          contextKey(event.context) === key &&
          typeof event.file === "string" &&
          item.sources.some(
            (file) =>
              address(path.dirname(String(start.file)), String(event.file)) ===
              path.join(data.workspace, file),
          ),
      );
      if (end.success === false && errors.length && data.buildExitCode !== 0)
        sourceFailure = true;
    }
    requireEvidence(diagnostics.length <= 2000, "Native diagnostic bound");
    for (const event of diagnostics) {
      const diagnostic = z
        .object({
          code: z.string().min(1).max(128),
          message: string,
          severity: z.enum(["error", "warning"]),
          file: string,
          line: z.number().int().nonnegative(),
          project: file,
          context: contextSchema,
        })
        .parse(event);
      const compiler = starts.find(
        (start) =>
          contextKey(start.context) === contextKey(diagnostic.context) &&
          start.file === diagnostic.project,
      );
      const owner = declared.find(
        (item) => path.join(data.workspace, item.file) === diagnostic.project,
      );
      const source =
        compiler &&
        owner &&
        owner.sources.find(
          (source) =>
            path.join(data.workspace, source) ===
            address(path.dirname(diagnostic.project), diagnostic.file),
        );
      findings.push({
        ruleId: `dotnet-build/${diagnostic.code}`,
        level: source ? diagnostic.severity : "note",
        message: diagnostic.message,
        ...(source && diagnostic.line > 0
          ? {
              file: path.posix.join(check.project, source),
              line: diagnostic.line,
            }
          : {}),
      });
    }
    if (data.buildExitCode !== 0) {
      requireEvidence(
        data.events.find((event) => event.type === "finished")!.success ===
          false,
        "Native failed build agrees with exit",
      );
      return sourceFailure
        ? {
            status: "failed",
            findings,
            findingsComplete: false,
            reason:
              "The native .NET compiler reported source errors; remaining build and analysis participation is incomplete",
          }
        : {
            status: "error",
            findings,
            findingsComplete: false,
            reason:
              "The .NET build failed without a reconciled native source compilation defect",
          };
    }
    requireEvidence(
      data.events.find((event) => event.type === "finished")!.success ===
        true && !diagnostics.some((event) => event.severity === "error"),
      "Native success agrees with diagnostics",
    );
    const projectStarts = data.events.filter(
      (event) =>
        event.type === "projectStarted" && typeof event.file === "string",
    );
    requireEvidence(
      projectStarts.every(
        (event) =>
          event.file ===
            path.join(data.workspace, invocation.config.solution) ||
          declared.some(
            (item) => event.file === path.join(data.workspace, item.file),
          ),
      ),
      "No foreign native project",
    );
    requireEvidence(
      same(
        data.generatedSources.map((g) =>
          JSON.stringify([
            g.project,
            g.file,
            g.generatorProject,
            g.generatorClass,
          ]),
        ),
        declared.flatMap((p) =>
          p.roslynGeneratedSources.map((g) =>
            JSON.stringify([
              p.file,
              path.join(data.workspace, g.file),
              g.generatorProject,
              g.generatorClass,
            ]),
          ),
        ),
      ),
      "Exact declared native source-generator output scope",
    );
    const allSources: string[] = [];
    for (const item of declared) {
      const moduleStarts = starts.filter(
        (event) => event.file === path.join(data.workspace, item.file),
      );
      requireEvidence(
        moduleStarts.length === 1,
        "Every declared project compiles exactly once",
      );
      const start = moduleStarts[0]!,
        key = contextKey(start.context),
        end = ends.find((event) => contextKey(event.context) === key)!;
      requireEvidence(
        end.success === true,
        "Successful native compiler terminal",
      );
      const parameters = data.events.filter(
          (event) =>
            event.type === "parameter" && contextKey(event.context) === key,
        ),
        parameter = (name: string) => {
          const values = parameters.filter((event) => event.name === name);
          requireEvidence(
            values.length === 1,
            "Unique compiler parameter: " + name,
          );
          return z.array(string).max(4096).parse(values[0]!.values);
        };
      const evaluations = data.events.filter(
        (event) => event.type === "evaluation" && event.file === start.file,
      );
      requireEvidence(
        evaluations.length === 1,
        "Unique native project evaluation",
      );
      const properties = z
        .record(z.string(), string)
        .parse(evaluations[0]!.properties);
      requireEvidence(
        properties.TargetFramework === item.targetFramework &&
          !properties.TargetFrameworks &&
          properties.AssemblyName === item.assemblyName &&
          properties.NETCoreSdkVersion === data.sdkVersion &&
          properties.MSBuildToolsPath === data.sdk &&
          properties.MSBuildSDKsPath === path.join(data.sdk, "Sdks") &&
          properties.RestorePackagesPath === repository &&
          properties.Configuration === "Debug" &&
          properties.UseSharedCompilation === "false" &&
          properties.BuildInParallel === "false" &&
          properties.RunAnalyzers === "true" &&
          properties.RunAnalyzersDuringBuild === "true" &&
          (item.language === "fsharp" ||
            properties.EnableNETAnalyzers === "true") &&
          (item.kind === "test"
            ? properties.IsTestProject === "true"
            : properties.IsTestProject !== "true"),
        "Selected SDK, framework, project role and analysis participation",
      );
      requireEvidence(
        parameter("DebugType")[0] === "portable" &&
          parameter("Deterministic")[0] === "True",
        "Native output and symbol options",
      );
      for (const name of ["SkipCompilerExecution", "SkipAnalyzers"])
        requireEvidence(
          !parameters.some(
            (event) =>
              event.name === name &&
              z
                .array(string)
                .parse(event.values)
                .some((value) => value.toLowerCase() === "true"),
          ),
          "Compiler and analyzer execution not disabled",
        );
      const commands = data.events.filter(
        (event) =>
          event.type === "compilerCommand" && contextKey(event.context) === key,
      );
      if (item.language === "fsharp") {
        requireEvidence(
          parameter("ToolExe")[0] === "dotnet" &&
            parameter("ToolPath")[0] === path.resolve(data.sdk, "../..") &&
            parameter("DotnetFscCompilerPath")[0] ===
              '"' + path.join(data.sdk, "FSharp/fsc.dll") + '"',
          "Selected F# compiler host",
        );
      } else {
        requireEvidence(
          commands.length === 1 &&
            typeof commands[0]!.line === "string" &&
            commands[0]!.line.startsWith(
              path.join(
                data.sdk,
                "Roslyn/bincore",
                item.language === "csharp" ? "csc" : "vbc",
              ) + " ",
            ) &&
            data.events.indexOf(commands[0]!) > data.events.indexOf(start) &&
            data.events.indexOf(commands[0]!) < data.events.indexOf(end),
          "Selected Roslyn compiler command",
        );
      }
      const base = path.dirname(path.join(data.workspace, item.file)),
        extension = extensions[item.language],
        stem = path.basename(item.file, "." + extension + "proj"),
        sources = parameter("Sources").map((file) => address(base, file));
      requireEvidence(
        new Set(sources).size === sources.length &&
          item.sources.every((file) =>
            sources.includes(path.join(data.workspace, file)),
          ),
        "Every selected compiler source",
      );
      const generatorSources = data.generatedSources.filter(
        (g) => g.project === item.file,
      );
      if (item.roslynGeneratedSources.length) {
        requireEvidence(
          item.language !== "fsharp" &&
            properties.EmitCompilerGeneratedFiles === "true" &&
            properties.CompilerGeneratedFilesOutputPath ===
              "obj/Debug/net10.0/generated" &&
            parameter("GeneratedFilesOutputPath").length === 1 &&
            parameter("GeneratedFilesOutputPath")[0] ===
              "obj/Debug/net10.0/generated",
          "Native generated-file emission and exact fresh output directory",
        );
      }
      for (const generated of generatorSources) {
        const spec = item.roslynGeneratedSources.find(
            (g) => path.join(data.workspace, g.file) === generated.file,
          )!,
          producer = declared.find(
            (p) => p.file === generated.generatorProject,
          ),
          module = data.modules.find(
            (p) => p.file === generated.generatorProject,
          );
        requireEvidence(
          producer &&
            producer.language === "csharp" &&
            producer.kind === "library" &&
            producer !== item &&
            spec.generatorClass === generated.generatorClass &&
            spec.generatorProject === generated.generatorProject,
          "Declared source generator producer and class",
        );
        const expectedAssembly = path.join(
            data.workspace,
            path.dirname(producer.file),
            "bin/Debug/net10.0",
            producer.assemblyName + ".dll",
          ),
          expectedDirectory = path.join(
            base,
            "obj/Debug/net10.0/generated",
            producer.assemblyName,
            generated.generatorClass,
          );
        requireEvidence(
          generated.producerAssembly === expectedAssembly &&
            path.dirname(generated.file) === expectedDirectory &&
            generated.file.endsWith("." + extension) &&
            !sources.includes(generated.file),
          "Native generated source path and distinct origin",
        );
        requireEvidence(
          parameter("Analyzers")
            .map((f) => address(base, f))
            .includes(expectedAssembly) &&
            data.observedArtifacts.some(
              (p) =>
                p.file === expectedAssembly &&
                p.sha256 === generated.producerAssemblySha256 &&
                p.bytes > 0,
            ),
          "Selected freshly built generator is a native compiler analyzer input",
        );
        const type = module?.metadata?.types.find(
          (t) => t.className === generated.generatorClass,
        );
        requireEvidence(
          module?.assembly === expectedAssembly &&
            type &&
            type.interfaces.some((i) =>
              [
                "Microsoft.CodeAnalysis.IIncrementalGenerator",
                "Microsoft.CodeAnalysis.ISourceGenerator",
              ].includes(i),
            ) &&
            type.methods.some(
              (m) =>
                m.name === "Initialize" &&
                m.files.some((f) =>
                  producer.sources.some(
                    (source) => path.join(data.workspace, source) === f,
                  ),
                ),
            ),
          "Source-bound native direct generator contract and initializer",
        );
        const pin = data.compiledSources.find((p) => p.file === generated.file);
        requireEvidence(
          pin &&
            pin.bytes === generated.bytes &&
            pin.sha256 === generated.sha256 &&
            pin.sha1 === generated.sha1 &&
            data.modules
              .find((m) => m.file === item.file)
              ?.metadata?.documents.some((d) => d.file === generated.file),
          "Generated source bytes and consumer portable-symbol participation",
        );
      }
      const sdkGenerated = [
        `.NETCoreApp,Version=v10.0.AssemblyAttributes.${extension}`,
        `${stem}.AssemblyInfo.${extension}`,
        ...(item.language === "csharp" ? [`${stem}.GlobalUsings.g.cs`] : []),
      ].map((file) => path.join(base, "obj/Debug/net10.0", file));
      const packageProgram = path.join(
        repository,
        `microsoft.net.test.sdk/18.10.1/build/net8.0/Microsoft.NET.Test.Sdk.Program.${extension}`,
      );
      const allowed = new Set([
        ...item.sources.map((file) => path.join(data.workspace, file)),
        ...item.generatedSources.map((file) => path.join(data.workspace, file)),
        ...sdkGenerated,
        packageProgram,
      ]);
      requireEvidence(
        sources.every((file) => allowed.has(file)) &&
          item.generatedSources.every((file) =>
            sources.includes(path.join(data.workspace, file)),
          ),
        "Exact declared and SDK generated source scope",
      );
      for (const file of sources) {
        const observed = data.compiledSources.find((pin) => pin.file === file);
        requireEvidence(observed, "Observed compiler source bytes");
        const relative = path.relative(data.workspace, file),
          original = invocation.inputs.find((pin) => pin.path === relative);
        if (original)
          requireEvidence(
            observed.sha256 === original.sha256,
            "Native source digest binding",
          );
        else if (file.startsWith(repository + path.sep))
          requireEvidence(
            pins.files.some(
              (pin) =>
                path.join(repository, pin.path) === file &&
                pin.sha256 === observed.sha256 &&
                pin.bytes === observed.bytes,
            ),
            "Pinned package program source",
          );
      }
      allSources.push(...sources, ...generatorSources.map((g) => g.file));
      requireEvidence(
        parameter("OutputAssembly")[0] !== undefined &&
          address(base, parameter("OutputAssembly")[0]!) ===
            path.join(base, "obj/Debug/net10.0", item.assemblyName + ".dll"),
        "Fresh native compiler output",
      );
      for (const name of [
        "References",
        ...(item.language === "fsharp"
          ? []
          : ["Analyzers", "AnalyzerConfigFiles"]),
      ])
        for (const value of parameter(name)) {
          const file = address(base, value),
            observed = data.observedArtifacts.find((pin) => pin.file === file);
          requireEvidence(observed, "Observed compiler dependency");
          if (file.startsWith(repository + path.sep))
            requireEvidence(
              pins.files.some(
                (pin) =>
                  path.join(repository, pin.path) === file &&
                  pin.sha256 === observed.sha256 &&
                  pin.bytes === observed.bytes,
              ),
              "Pinned compiler dependency bytes",
            );
          else
            requireEvidence(
              (name === "AnalyzerConfigFiles" &&
                file ===
                  path.join(
                    data.sdk,
                    "Sdks/Microsoft.NET.Sdk/analyzers/build/config/analysislevel_10_default.globalconfig",
                  )) ||
                (name === "AnalyzerConfigFiles" &&
                  check.id === "dotnet.format-extensions" &&
                  additionalSdkAnalyzerConfigs.get(file)?.sha256 ===
                    observed.sha256 &&
                  additionalSdkAnalyzerConfigs.get(file)?.bytes ===
                    observed.bytes) ||
                (name === "AnalyzerConfigFiles" &&
                  (file ===
                    path.join(
                      base,
                      "obj/Debug/net10.0",
                      stem + ".GeneratedMSBuildEditorConfig.editorconfig",
                    ) ||
                    invocation.inputs.some(
                      (input) =>
                        path.join(data.workspace, input.path) === file &&
                        /(?:\.editorconfig|\.globalconfig)$/.test(input.path) &&
                        input.sha256 === observed.sha256,
                    ))) ||
                (name === "References" &&
                  file ===
                    path.join(
                      data.sdk,
                      "Roslyn/bincore/Microsoft.CodeAnalysis.dll",
                    ) &&
                  declared.some((consumer) =>
                    consumer.roslynGeneratedSources.some(
                      (g) => g.generatorProject === item.file,
                    ),
                  )) ||
                (name === "References" &&
                  file.startsWith(
                    path.join(
                      path.resolve(data.sdk, "../.."),
                      "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0",
                    ) + path.sep,
                  ) &&
                  file.endsWith(".dll")) ||
                (name === "Analyzers" &&
                  file.startsWith(
                    path.join(
                      path.resolve(data.sdk, "../.."),
                      "packs/Microsoft.NETCore.App.Ref/10.0.12/analyzers/dotnet/cs",
                    ) + path.sep,
                  ) &&
                  file.endsWith(".dll")) ||
                (name === "Analyzers" &&
                  file.startsWith(
                    path.join(data.sdk, "Sdks/Microsoft.NET.Sdk/analyzers") +
                      path.sep,
                  ) &&
                  file.endsWith(".dll")) ||
                declared.some((project) =>
                  [
                    path.join(
                      data.workspace,
                      path.dirname(project.file),
                      "obj/Debug/net10.0/ref",
                      project.assemblyName + ".dll",
                    ),
                    path.join(
                      data.workspace,
                      path.dirname(project.file),
                      "bin/Debug/net10.0",
                      project.assemblyName + ".dll",
                    ),
                  ].includes(file),
                ),
              "Admitted SDK or reactor dependency",
            );
        }
      const captured = data.modules.find(
        (module) => module.file === item.file,
      )!;
      requireEvidence(
        captured.assembly ===
          path.join(base, "bin/Debug/net10.0", item.assemblyName + ".dll") &&
          captured.pdb ===
            path.join(base, "bin/Debug/net10.0", item.assemblyName + ".pdb") &&
          captured.metadata?.assemblyName === item.assemblyName,
        "Fresh output assembly and symbols",
      );
      for (const document of captured.metadata.documents) {
        const source = data.compiledSources.find(
          (pin) => pin.file === document.file,
        );
        if (!source) {
          requireEvidence(
            check.id === "dotnet.format-extensions" &&
              document.hash === "" &&
              document.algorithm === "00000000-0000-0000-0000-000000000000" &&
              nativeMappedDocuments.get(item.file)?.has(document.file),
            "Every virtual symbol document has a native source mapping in this project",
          );
          continue;
        }
        requireEvidence(
          document.algorithm === "8829d00f-11b8-4213-878b-770e8597ac16"
            ? document.hash === source.sha256
            : document.algorithm === "ff1816ec-aa5e-4d10-87f7-6f4963833460" &&
                document.hash === source.sha1,
          "Native symbol source checksum",
        );
      }
      for (const declaredClass of item.testClasses)
        requireEvidence(
          captured.metadata.types.some(
            (type) =>
              type.className === declaredClass.className &&
              type.methods.some((method) =>
                method.files.includes(
                  path.join(data.workspace, declaredClass.file),
                ),
              ),
          ),
          "Native test class source binding",
        );
    }
    requireEvidence(
      same(
        data.compiledSources.map((pin) => pin.file),
        [...new Set(allSources)],
      ),
      "Exact observed compiler source closure",
    );
    requireEvidence(
      data.nativeReceipts.reduce(
        (sum, receipt) => sum + receipt.stdoutBytes + receipt.stderrBytes,
        0,
      ) <=
        8 * 1024 * 1024 &&
        data.nativeReceipts.filter((receipt) => receipt.phase === "build")
          .length === 1 &&
        data.nativeReceipts.find((receipt) => receipt.phase === "build")!
          .exitCode === data.buildExitCode &&
        data.nativeReceipts.filter((receipt) => receipt.phase === "restore")
          .length === 1,
      "Bounded native call ledger",
    );
    return {
      status: "passed",
      findings,
      findingsComplete: true,
      reason:
        "Every declared C#/F#/VB project compiled fresh source and reconciled native compiler inputs, generator outputs, dependencies and output symbols",
    };
  } catch {
    return sourceFailure
      ? {
          status: "failed",
          findings,
          findingsComplete: false,
          reason:
            "A native .NET source compilation failure was observed; remaining evidence is incomplete",
        }
      : incomplete;
  }
}
