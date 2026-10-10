import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import {
  dotnetFormatExtensionsConfigSchema,
  dotnetFormatterRequire as need,
  verifyDotnetFormatterSdk,
} from "./dotnet-format-extensions.js";
import { dotnetFormatterSdkPins } from "./dotnet-formatter-pins.js";
import { fsharpSdkPins } from "./fsharp-format-pins.js";
import { dotnetFormatExtensionsNativeSource } from "./dotnet-format-extensions-native.js";
import {
  dotnetFormatExtensionsNativeSchema,
  dotnetFormatExtensionsPacketSchema,
  dotnetFormatExtensionsRuntimeConfig,
  dotnetFormattingCompileArguments,
  dotnetFormattingCompileWarning,
} from "./dotnet-format-extensions-contract.js";
import { mavenHash } from "./maven.js";
import { jvmInvoker } from "./jvm-invoke.js";
import { captureProcessOutput } from "./process-output.js";
interface Context {
  sdk: string;
  workspace: string;
  repository: string;
  observer: string;
  references: string[];
  invocation: z.infer<typeof dotnetBuildInvocationSchema>;
  config: z.infer<typeof dotnetFormatExtensionsConfigSchema>;
  env: NodeJS.ProcessEnv;
  compiledSources: Map<string, { bytes: number; sha256: string; sha1: string }>;
  ownedPins: Map<string, string>;
  observe: (file: string) => Promise<{ bytes: number; sha256: string }>;
  regular: (file: string, bound: number) => Promise<Buffer>;
}
export async function collectDotnetFormattingExtensions(context: Context) {
  const {
    sdk,
    workspace,
    repository,
    observer,
    references,
    invocation,
    config,
    env,
    compiledSources,
    ownedPins,
    observe,
    regular,
  } = context;
  const sdkRoot = path.resolve(sdk, "../.."),
    tool = await verifyDotnetFormatterSdk(sdkRoot),
    directory = path.join(observer, "format-extensions");
  await mkdir(directory);
  const source = path.join(directory, "ChecktrailFormattingExtensions.cs"),
    helper = path.join(directory, "ChecktrailFormattingExtensions.dll"),
    runtime = path.join(
      directory,
      "ChecktrailFormattingExtensions.runtimeconfig.json",
    ),
    request = path.join(directory, "request.json"),
    markerFile = path.join(directory, "body-entered.json"),
    firstFile = path.join(directory, "first-document.json"),
    completedFile = path.join(directory, "completed.json");
  const stage = async (file: string, bytes: string) => {
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    ownedPins.set(file, mavenHash(bytes));
  };
  const policy = await regular(
    path.join(workspace, "checktrail.dotnet-format.json"),
    65536,
  );
  need(
    isDeepStrictEqual(
      dotnetFormatExtensionsConfigSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(policy)),
      ),
      config,
    ),
    "Current native formatting policy",
  );
  const sources = [...compiledSources.keys()].sort();
  need(
    sources.length > 0 &&
      sources.length <= 4096 &&
      sources.every(
        (file) =>
          file.startsWith(workspace + path.sep) ||
          file.startsWith(repository + path.sep),
      ),
    "Complete fresh physical compiler document cohort",
  );
  for (const file of sources) {
    const bytes = await regular(file, 65536);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    need(
      mavenHash(bytes) === compiledSources.get(file)!.sha256,
      "Fresh formatting source identity",
    );
  }
  await stage(source, dotnetFormatExtensionsNativeSource);
  await stage(runtime, dotnetFormatExtensionsRuntimeConfig);
  const selectedSources = invocation.config.projects
    .flatMap((p) => [
      ...p.sources,
      ...p.generatedSources,
      ...p.roslynGeneratedSources.map((g) => g.file),
    ])
    .map((file) => path.join(workspace, file))
    .sort();
  need(
    new Set(selectedSources).size === selectedSources.length &&
      selectedSources.every((file) => compiledSources.has(file)),
    "Every declared original and generated formatting input was compiled",
  );
  await stage(
    request,
    JSON.stringify({
      solution: path.join(workspace, invocation.config.solution),
      repository,
      sources: selectedSources,
      styleDiagnostics: config.styleDiagnostics,
      analyzerDiagnostics: config.analyzerDiagnostics,
      severity: { info: "Info", warn: "Warning", error: "Error" }[
        config.severity
      ],
    }),
  );
  const mirrored: Buffer[] = [];
  let observedBytes = 0;
  const native = jvmInvoker(env, true, (chunk) => {
    observedBytes += chunk.length;
    mirrored.push(Buffer.from(chunk));
  });
  const phases: NonNullable<
    z.infer<typeof dotnetFormatExtensionsPacketSchema>["extensions"]
  >["phases"] = [];
  const invoke = async (
    phase: "compile-formatting-observer" | "formatting-documents",
    args: string[],
    cwd: string,
  ) => {
    need(phases.length < 2, "Native formatting call bound");
    const result = await native(tool, args, cwd);
    need(
      !result.error &&
        result.status === 0 &&
        result.signal === null &&
        observedBytes <= 2 * 1024 * 1024,
      "Native formatting invocation did not complete",
    );
    const { error, ...fields } = result;
    need(!error, "Native formatting invocation error");
    phases.push({
      phase,
      tool,
      args,
      cwd,
      ...fields,
      status: 0,
      signal: null,
      capturedOutput: captureProcessOutput(
        Buffer.from(result.stdout),
        Buffer.from(result.stderr),
        result.stdoutBytes + result.stderrBytes,
        true,
      ),
    });
    return result;
  };
  const compiled = await invoke(
    "compile-formatting-observer",
    dotnetFormattingCompileArguments(sdk, directory, references),
    directory,
  );
  need(
    compiled.stdout === dotnetFormattingCompileWarning && !compiled.stderr,
    "Only the exact observed SDK reference warning is admitted",
  );
  ownedPins.set(helper, mavenHash(await regular(helper, 1024 * 1024)));
  const formatted = await invoke(
    "formatting-documents",
    ["exec", helper, sdk, request, markerFile, firstFile, completedFile],
    workspace,
  );
  need(!formatted.stderr, "Native formatting observer stderr");
  const report = dotnetFormatExtensionsNativeSchema.parse(
    JSON.parse(formatted.stdout),
  );
  need(
    report.processId === formatted.pid &&
      report.helperSha256 === ownedPins.get(helper) &&
      !report.workspaceFailures.length &&
      report.phases.every((p) => !p.analyzerExceptions.length),
    "Native formatting process and complete workspace",
  );
  const selectedPins: ReadonlyArray<{
    file: string;
    bytes: number;
    sha256: string;
  }> = [
    ...(fsharpSdkPins as ReadonlyArray<{
      file: string;
      bytes: number;
      sha256: string;
    }>),
    ...(dotnetFormatterSdkPins as ReadonlyArray<{
      file: string;
      bytes: number;
      sha256: string;
    }>),
  ];
  const allowed = new Map(
    selectedPins.map((pin) => [path.join(sdkRoot, pin.file), pin]),
  );
  const moduleOutputs = invocation.config.projects.map((p) =>
    path.join(
      workspace,
      path.dirname(p.file),
      "bin/Debug/net10.0",
      p.assemblyName + ".dll",
    ),
  );
  for (const module of report.loaded) {
    if (module.file === helper) {
      need(
        module.sha256 === ownedPins.get(helper),
        "Original formatting observer module",
      );
      continue;
    }
    const selected = allowed.get(module.file);
    if (selected)
      need(
        module.sha256 === selected.sha256,
        "Selected native SDK module bytes",
      );
    else
      need(
        moduleOutputs.includes(module.file) ||
          module.file.startsWith(repository + path.sep),
        "Native module must belong to selected SDK or declared fresh project/dependency outputs",
      );
    const current = await observe(module.file);
    need(
      current.sha256 === module.sha256,
      "Current loaded formatting module bytes",
    );
  }
  for (const file of sources)
    need(
      mavenHash(await regular(file, 65536)) ===
        compiledSources.get(file)!.sha256,
      "Native formatting preserved every source",
    );
  await verifyDotnetFormatterSdk(sdkRoot);
  const marker = JSON.parse(
      (await regular(markerFile, 65536)).toString("utf8"),
    ),
    firstDocument = JSON.parse(
      (await regular(firstFile, 65536)).toString("utf8"),
    );
  const completed = JSON.parse(
    (await regular(completedFile, 65536)).toString("utf8"),
  );
  need(
    completed.observationSha256 === mavenHash(formatted.stdout) &&
      completed.processId === formatted.pid,
    "Complete native observation marker",
  );
  ownedPins.set(completedFile, mavenHash(await regular(completedFile, 65536)));
  ownedPins.set(markerFile, mavenHash(await regular(markerFile, 65536)));
  ownedPins.set(firstFile, mavenHash(await regular(firstFile, 65536)));
  return {
    sdkRoot,
    temporary: path.dirname(workspace),
    observerDirectory: directory,
    policySha256: mavenHash(policy),
    sdkPinsSha256: mavenHash(JSON.stringify(dotnetFormatterSdkPins)),
    helperSourceSha256: ownedPins.get(source),
    helperSha256: ownedPins.get(helper),
    requestFileSha256: ownedPins.get(request),
    runtimeConfigSha256: ownedPins.get(runtime),
    marker,
    firstDocument,
    completed,
    phases,
    mirroredBytes: observedBytes,
    mirroredSha256: mavenHash(Buffer.concat(mirrored)),
    complete: true,
  };
}
