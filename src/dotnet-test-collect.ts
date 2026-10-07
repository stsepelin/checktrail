import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { SpawnSyncReturns } from "node:child_process";
import { dotnetTestNativeSource } from "./dotnet-test-native.js";
import { dotnetNunitSettings } from "./dotnet-nunit.js";
import { mavenHash } from "./maven.js";
import type { z } from "zod";
import type { dotnetBuildInvocationSchema } from "./dotnet-build.js";
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
  events: (file: string) => Promise<Record<string, unknown>[]>;
}
export async function collectDotnetTests(context: Context) {
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
    events,
  } = context;
  const source = path.join(observer, "ChecktrailTestLogger.cs"),
    helper = path.join(observer, "Checktrail.TestLogger.dll"),
    objectModel = path.join(
      sdk,
      "Microsoft.VisualStudio.TestPlatform.ObjectModel.dll",
    ),
    console = path.join(sdk, "vstest.console.dll"),
    adapter = path.join(
      repository,
      "nunit3testadapter/5.0.0/build/netcoreapp3.1",
    );
  for (const file of [
    objectModel,
    console,
    path.join(sdk, "vstest.console.runtimeconfig.json"),
    path.join(sdk, "vstest.console.deps.json"),
    path.join(adapter, "NUnit3.TestAdapter.dll"),
  ])
    await observe(file);
  await writeFile(source, dotnetTestNativeSource, { flag: "wx" });
  const compiled = invoke(
    "test-observer-compile",
    [
      "exec",
      path.join(sdk, "Roslyn/bincore/csc.dll"),
      "-nologo",
      "-noconfig",
      "-nostdlib+",
      "-target:library",
      // The pinned VSTest ObjectModel targets Runtime 8; execution verifies Runtime 10.
      "-nowarn:1701",
      `-out:${helper}`,
      ...references.map((file) => `-r:${file}`),
      `-r:${objectModel}`,
      source,
    ],
    observer,
  );
  if (compiled.status !== 0 || compiled.stdout.trim() || compiled.stderr)
    throw Error("Native test observer did not compile");
  ownedPins.set(source, mavenHash(await regular(source, 1024 * 1024)));
  ownedPins.set(helper, mavenHash(await regular(helper, 1024 * 1024)));
  const runs = [];
  for (const project of invocation.config.projects.filter(
    (item) => item.kind === "test",
  )) {
    const base = path.join(
        workspace,
        path.dirname(project.file),
        "bin/Debug/net10.0",
      ),
      assembly = path.join(base, project.assemblyName + ".dll"),
      pdb = path.join(base, project.assemblyName + ".pdb"),
      directory = path.join(observer, "tests-" + runs.length);
    await mkdir(directory);
    const artifacts = [];
    for (const file of [
      assembly,
      pdb,
      path.join(base, project.assemblyName + ".runtimeconfig.json"),
      path.join(base, project.assemblyName + ".deps.json"),
    ])
      artifacts.push({ file, ...(await observe(file)) });
    const discoveryFile = path.join(directory, "discovery.jsonl"),
      executionFile = path.join(directory, "execution.jsonl"),
      trxFile = path.join(directory, "result.trx");
    const settingsFile = path.join(directory, "checktrail.runsettings"),
      settings = dotnetNunitSettings(directory);
    await writeFile(settingsFile, settings, { flag: "wx" });
    ownedPins.set(settingsFile, mavenHash(settings));
    const nativeXml = async (file: string) => {
      try {
        const bytes = await regular(file, 1024 * 1024);
        return {
          file,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          sha256: mavenHash(bytes),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const common = [
      "exec",
      console,
      assembly,
      `/Settings:${settingsFile}`,
      "/Framework:.NETCoreApp,Version=v10.0",
      `/TestAdapterPath:${observer};${adapter}`,
    ];
    const discovery = invoke(
      "test-discovery:" + project.file,
      [
        ...common,
        "/ListTests",
        `/Logger:checktrail-local;LogFilePath=${discoveryFile}`,
      ],
      workspace,
    );
    const discoveryEvents = await events(discoveryFile);
    const discoveryXml = await nativeXml(
      path.join(base, "Dump", "D_" + project.assemblyName + ".dll.dump"),
    );
    const execution = invoke(
      "test-execution:" + project.file,
      [
        ...common,
        `/Logger:checktrail-local;LogFilePath=${executionFile}`,
        "/Logger:trx;LogFileName=result.trx",
        `/ResultsDirectory:${directory}`,
      ],
      workspace,
    );
    const executionEvents = await events(executionFile);
    const executionXml = await nativeXml(
      path.join(directory, project.assemblyName + ".xml"),
    );
    let trx = "";
    try {
      trx = new TextDecoder("utf-8", { fatal: true }).decode(
        await regular(trxFile, 1024 * 1024),
      );
    } catch (error) {
      // The pinned runner can omit TRX when discovery is empty. Retain the
      // native zero-case events; the parser keeps that project incomplete.
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        !discoveryEvents.some(
          (e) => e.type === "discoveryFinished" && e.total === 0,
        )
      )
        throw error;
    }
    runs.push({
      file: project.file,
      assembly,
      artifacts,
      discoveryExitCode: discovery.status,
      executionExitCode: execution.status,
      discoveryLauncherPid: discovery.pid,
      executionLauncherPid: execution.pid,
      discoveryEvents,
      executionEvents,
      trx,
      nunit: {
        settingsFile,
        settingsSha256: mavenHash(settings),
        discovery: discoveryXml,
        execution: executionXml,
      },
    });
  }
  return {
    observerSha256: ownedPins.get(helper),
    observerSourceSha256: ownedPins.get(source),
    runs,
  };
}
