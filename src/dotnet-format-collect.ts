import path from "node:path";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import type { SpawnSyncReturns } from "node:child_process";
import type { z } from "zod";
import type { dotnetBuildInvocationSchema } from "./dotnet-build.js";
import { dotnetFormatNativeSource } from "./dotnet-format-native.js";
import { mavenHash } from "./maven.js";
interface Context {
  sdk: string;
  workspace: string;
  repository: string;
  observer: string;
  references: string[];
  invocation: z.infer<typeof dotnetBuildInvocationSchema>;
  ownedPins: Map<string, string>;
  invoke: (
    phase: string,
    args: string[],
    cwd: string,
  ) => SpawnSyncReturns<string>;
  observe: (file: string) => Promise<{ bytes: number; sha256: string }>;
  regular: (file: string, bound: number) => Promise<Buffer>;
}
export async function collectDotnetFormatting(context: Context) {
  const {
    sdk,
    workspace,
    repository,
    observer,
    references,
    invocation,
    ownedPins,
    invoke,
    observe,
    regular,
  } = context;
  const tools = path.join(sdk, "DotnetTools/dotnet-format"),
    directory = path.join(observer, "format");
  await mkdir(directory);
  // Copy only observed regular SDK inputs; the native workspace locates its
  // BuildHost beside the observer. Every copied byte is rechecked by the runner.
  const toolFiles = (await readdir(tools, { recursive: true }))
    .filter((f) => /\.(?:dll|json)$/.test(f))
    .sort();
  if (toolFiles.length > 1024) throw Error("Formatter SDK closure bound");
  for (const file of toolFiles) {
    const input = path.join(tools, file);
    const pin = await observe(input);
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(input, target, { errorOnExist: true });
    const copied = await regular(target, 64 * 1024 * 1024);
    if (copied.length !== pin.bytes || mavenHash(copied) !== pin.sha256)
      throw Error("Copied formatter SDK input differs from observed bytes");
    ownedPins.set(target, pin.sha256);
  }
  const source = path.join(directory, "ChecktrailFormat.cs"),
    helper = path.join(directory, "ChecktrailFormat.dll"),
    runtime = path.join(directory, "ChecktrailFormat.runtimeconfig.json"),
    request = path.join(directory, "request.json");
  await writeFile(source, dotnetFormatNativeSource, { flag: "wx" });
  await writeFile(
    runtime,
    JSON.stringify({
      runtimeOptions: {
        tfm: "net10.0",
        framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
        rollForward: "Disable",
      },
    }),
    { flag: "wx" },
  );
  const sources = invocation.config.projects.flatMap((p) => [
    ...p.sources,
    ...p.generatedSources,
  ]);
  await writeFile(
    request,
    JSON.stringify({
      projects: invocation.config.projects.map((p) =>
        path.join(workspace, p.file),
      ),
      sources: sources.map((f) => path.join(workspace, f)),
    }),
    { flag: "wx" },
  );
  const compiled = invoke(
    "format-observer-compile",
    [
      "exec",
      path.join(sdk, "Roslyn/bincore/csc.dll"),
      "-nologo",
      "-noconfig",
      "-nostdlib+",
      "-target:exe",
      // The pinned MSBuild Locator targets Runtime 8; execution verifies Runtime 10.
      "-nowarn:1701",
      `-out:${helper}`,
      ...references.map((f) => `-r:${f}`),
      ...[
        "Microsoft.CodeAnalysis.dll",
        "Microsoft.CodeAnalysis.Workspaces.dll",
        "Microsoft.CodeAnalysis.Workspaces.MSBuild.dll",
        "BuildHost-netcore/Microsoft.Build.Locator.dll",
      ].map((f) => `-r:${path.join(tools, f)}`),
      source,
    ],
    directory,
  );
  if (compiled.status !== 0 || compiled.stdout.trim() || compiled.stderr)
    throw Error("Native formatter observer did not compile cleanly");
  for (const file of [source, helper, runtime, request])
    ownedPins.set(file, mavenHash(await regular(file, 1024 * 1024)));
  const observed = invoke(
    "format-documents",
    ["exec", helper, sdk, repository, request],
    workspace,
  );
  if (observed.status !== 0 || observed.stderr)
    throw Error("Native formatter document observation failed");
  const reportDirectory = path.join(directory, "native-report");
  await mkdir(reportDirectory);
  const formatted = invoke(
    "format-whitespace",
    [
      "exec",
      path.join(tools, "dotnet-format.dll"),
      "whitespace",
      path.join(workspace, invocation.config.solution),
      "--no-restore",
      "--verify-no-changes",
      "--verbosity",
      "diagnostic",
      "--report",
      reportDirectory,
      "--include",
      ...sources,
    ],
    workspace,
  );
  const report = new TextDecoder("utf-8", { fatal: true }).decode(
    await regular(
      path.join(reportDirectory, "format-report.json"),
      1024 * 1024,
    ),
  );
  return {
    observerDirectory: directory,
    observerSourceSha256: ownedPins.get(source),
    observerSha256: ownedPins.get(helper),
    documentLauncherPid: observed.pid,
    documents: observed.stdout,
    formatterExitCode: formatted.status,
    formatterStdout: formatted.stdout,
    formatterStderr: formatted.stderr,
    report,
  };
}
