import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  dotnetBuildInvocationSchema,
  dotnetBuildProtectedEnvironment,
  dotnetBuildRepository,
} from "./dotnet-build.js";
import { dotnetBuildNativeSource } from "./dotnet-build-native.js";
import { collectDotnetTests } from "./dotnet-test-collect.js";
import { collectDotnetFormatting } from "./dotnet-format-collect.js";
import {
  collectDotnetGeneratedSources,
  DotnetGeneratedScopeError,
} from "./dotnet-generated-collect.js";
import { mavenHash, mavenLocal, verifyMavenTree } from "./maven.js";
import { collectDotnetFormattingExtensions } from "./dotnet-format-extensions-collect.js";
import {
  dotnetFormatExtensionsConfigSchema,
  selectedDotnetFormatterSdk,
} from "./dotnet-format-extensions.js";
let invokeExecutable = "dotnet";

const receipts: {
  phase: string;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  durationMs: number;
}[] = [];
let nativeBytes = 0;
const env: NodeJS.ProcessEnv = { ...process.env };
for (const name of dotnetBuildProtectedEnvironment) delete env[name];
Object.assign(env, {
  PATH: process.env.PATH ?? "",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  DOTNET_CLI_USE_MSBUILD_SERVER: "0",
  MSBUILDDISABLENODEREUSE: "1",
  DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: "1",
  DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "0",
  DOTNET_EnableDiagnostics: "0",
});
function invoke(phase: string, args: string[], cwd: string) {
  if (receipts.length >= 80) throw Error("Native call bound");
  const started = performance.now(),
    result = spawnSync(invokeExecutable, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  if (result.error || result.signal || result.status === null)
    throw Error("Native invocation interrupted");
  const stdoutBytes = Buffer.byteLength(result.stdout),
    stderrBytes = Buffer.byteLength(result.stderr);
  nativeBytes += stdoutBytes + stderrBytes;
  if (nativeBytes > 8 * 1024 * 1024)
    throw Error("Aggregate native output bound");
  receipts.push({
    phase,
    exitCode: result.status,
    stdoutBytes,
    stderrBytes,
    stdoutSha256: mavenHash(result.stdout),
    stderrSha256: mavenHash(result.stderr),
    durationMs: Math.round(performance.now() - started),
  });
  return result;
}
async function regular(file: string, bound: number) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > bound ||
    (await realpath(file)) !== file
  )
    throw Error("Bounded canonical regular file required");
  const bytes = await readFile(file);
  if (bytes.length > bound) throw Error("File read bound");
  return bytes;
}
async function events(file: string) {
  const bytes = await regular(file, 2 * 1024 * 1024),
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw Error("Partial native event");
  const lines = text.trimEnd().split("\n");
  if (lines.length > 20000) throw Error("Native event count bound");
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
async function main() {
  const temporary = await mkdtemp(
    path.join(
      process.env.CHECKTRAIL_TEMP ?? tmpdir(),
      "checktrail-dotnet-build-",
    ),
  );
  try {
    const home = path.join(temporary, "home");
    await mkdir(home);
    const scratch = path.join(temporary, "scratch");
    await mkdir(scratch);
    env.TMPDIR = env.TMP = env.TEMP = scratch;
    env.NUGET_SCRATCH = path.join(scratch, "nuget");
    env.HOME = home;
    env.DOTNET_CLI_HOME = home;
    env.NUGET_HTTP_CACHE_PATH = path.join(home, "http");
    let sdk: string;
    const extensionFlag = process.argv[4] === "--format-extensions";
    const extensionConfig = extensionFlag
      ? dotnetFormatExtensionsConfigSchema.parse(JSON.parse(process.argv[5]!))
      : undefined;
    try {
      if (extensionFlag) {
        if (
          process.argv.length !== 6 &&
          !(process.argv.length === 7 && process.argv[6] === "--version")
        )
          throw Error("Exact formatting extension arguments required");
        const selected = await selectedDotnetFormatterSdk();
        invokeExecutable = selected.executable;
        env.DOTNET_ROOT = selected.root;
        env.DOTNET_MULTILEVEL_LOOKUP = "0";
        env.DOTNET_ROLL_FORWARD = "Disable";
        env.DOTNET_CLI_UI_LANGUAGE = "en-US";
      }
      const listed = invoke("sdk", ["--list-sdks"], temporary),
        matches = listed.stdout
          .split(/\r?\n/)
          .flatMap(
            (line) => /^10\.0\.401 \[([^\r\n]+)\]$/.exec(line)?.[1] ?? [],
          );
      if (listed.status !== 0 || listed.stderr || matches.length !== 1)
        throw Error("Pinned SDK missing");
      sdk = await realpath(path.join(matches[0]!, "10.0.401"));
      const compiler = invoke(
        "compiler-version",
        ["exec", path.join(sdk, "Roslyn/bincore/csc.dll"), "-version"],
        temporary,
      );
      if (
        compiler.status !== 0 ||
        compiler.stderr ||
        compiler.stdout.trim() !==
          "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)"
      )
        throw Error("Pinned compiler missing");
    } catch {
      process.stdout.write(
        JSON.stringify({ unavailable: "dotnet-build-toolchain" }),
      );
      process.exitCode = 3;
      return;
    }
    if (process.argv.slice(4).includes("--version")) {
      process.stdout.write("10.0.401\n");
      return;
    }
    const root = await realpath(process.argv[2]!),
      project = path.relative(root, await realpath(process.cwd())) || ".",
      invocation = dotnetBuildInvocationSchema.parse(
        JSON.parse(process.argv[3]!),
      ),
      dependencies = await dotnetBuildRepository(
        root,
        project,
        invocation.config,
      );
    const workspace = path.join(temporary, "workspace"),
      repository = path.join(temporary, "repository"),
      observer = path.join(temporary, "observer");
    await mkdir(workspace);
    await mkdir(observer);
    for (const input of invocation.inputs) {
      const bytes = await regular(
        await mavenLocal(root, project, input.path),
        4 * 1024 * 1024,
      );
      if (mavenHash(bytes) !== input.sha256)
        throw Error("Source changed before copy");
      const destination = path.join(workspace, input.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
    await cp(dependencies.repository, repository, {
      recursive: true,
      errorOnExist: true,
    });
    env.DOTNET_HOST_PATH = path.join(path.resolve(sdk, "../.."), "dotnet");
    const installation = path.resolve(sdk, "../.."),
      references = path.join(
        installation,
        "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0",
      ),
      builtins = (await readdir(references))
        .filter((file) => file.endsWith(".dll"))
        .sort()
        .map((file) => path.join(references, file));
    if (
      builtins.length > 512 ||
      !builtins.includes(path.join(references, "System.Runtime.dll"))
    )
      throw Error("Reference pack scope");
    const tools = new Map<string, { bytes: number; sha256: string }>();
    const observe = async (file: string) => {
      const resolved = await realpath(path.resolve(file));
      if (
        resolved !== path.resolve(file) ||
        !(
          resolved.startsWith(installation + path.sep) ||
          resolved.startsWith(repository + path.sep) ||
          resolved.startsWith(workspace + path.sep)
        )
      )
        throw Error("Native artifact outside admitted roots");
      const bytes = await regular(resolved, 64 * 1024 * 1024),
        pin = { bytes: bytes.length, sha256: mavenHash(bytes) };
      const previous = tools.get(resolved);
      if (previous && JSON.stringify(previous) !== JSON.stringify(pin))
        throw Error("Observed artifact changed");
      tools.set(resolved, pin);
      if (tools.size > 4096)
        throw Error("Observed native artifact count bound");
      return pin;
    };
    for (const file of [
      ...builtins,
      "MSBuild.dll",
      "Microsoft.Build.dll",
      "Microsoft.Build.Framework.dll",
      "Roslyn/Microsoft.Build.Tasks.CodeAnalysis.dll",
      "Roslyn/bincore/csc.dll",
      "Roslyn/bincore/vbc.dll",
      "FSharp/FSharp.Build.dll",
      "FSharp/fsc.dll",
      "FSharp/FSharp.Compiler.Service.dll",
    ].map((file) => (path.isAbsolute(file) ? file : path.join(sdk, file))))
      await observe(file);
    const source = path.join(observer, "ChecktrailBuild.cs"),
      helper = path.join(observer, "ChecktrailBuild.dll");
    await writeFile(source, dotnetBuildNativeSource);
    const bootstrap = invoke(
      "observer-compile",
      [
        "exec",
        path.join(sdk, "Roslyn/bincore/csc.dll"),
        "-nologo",
        "-noconfig",
        "-nostdlib+",
        "-target:exe",
        "-langversion:14",
        `-out:${helper}`,
        ...builtins.map((file) => `-r:${file}`),
        `-r:${path.join(sdk, "Microsoft.Build.Framework.dll")}`,
        source,
      ],
      observer,
    );
    if (bootstrap.status !== 0 || bootstrap.stdout.trim() || bootstrap.stderr)
      throw Error("Observer did not compile");
    await cp(
      path.join(sdk, "Microsoft.Build.Framework.dll"),
      path.join(observer, "Microsoft.Build.Framework.dll"),
    );
    const runtimeconfig = path.join(
      observer,
      "ChecktrailBuild.runtimeconfig.json",
    );
    await writeFile(
      runtimeconfig,
      JSON.stringify({
        runtimeOptions: {
          tfm: "net10.0",
          framework: { name: "Microsoft.NETCore.App", version: "10.0.12" },
          rollForward: "Disable",
        },
      }),
    );
    const ownedPins = new Map<string, string>();
    for (const file of [
      source,
      helper,
      runtimeconfig,
      path.join(observer, "Microsoft.Build.Framework.dll"),
    ])
      ownedPins.set(file, mavenHash(await readFile(file)));
    env.MSBuildSDKsPath = path.join(sdk, "Sdks");
    env.NUGET_PACKAGES = repository;
    const settings = path.join(temporary, "NuGet.Config");
    await writeFile(
      settings,
      '<configuration><packageSources><clear/><add key="local" value="' +
        repository +
        '"/></packageSources></configuration>\n',
    );
    ownedPins.set(settings, mavenHash(await readFile(settings)));
    const common = [
      "exec",
      path.join(sdk, "MSBuild.dll"),
      invocation.config.solution,
      "-nologo",
      "-v:diagnostic",
      "-noconsolelogger",
      "-m:1",
      "-nr:false",
      "-p:Configuration=Debug",
      "-p:BuildInParallel=false",
      "-p:UseSharedCompilation=false",
      `-p:RestorePackagesPath=${repository}`,
      `-p:RestoreSources=${repository}`,
      "-p:RestoreFallbackFolders=",
      "-p:RestoreLockedMode=true",
      "-p:NuGetAudit=false",
      ...(invocation.config.projects.some(
        (p) => p.roslynGeneratedSources.length,
      )
        ? [
            "-p:EmitCompilerGeneratedFiles=true",
            "-p:CompilerGeneratedFilesOutputPath=obj/Debug/net10.0/generated",
          ]
        : []),
    ];
    const restoreFile = path.join(temporary, "restore.jsonl"),
      restore = invoke(
        "restore",
        [
          ...common,
          "-t:Restore",
          `-p:RestoreConfigFile=${settings}`,
          `-logger:ChecktrailBuildLogger,${helper};${restoreFile}`,
        ],
        workspace,
      ),
      restoreEvents = await events(restoreFile);
    if (restore.status !== 0) {
      process.stdout.write(
        JSON.stringify({
          version: 1,
          prerequisiteFailure: "locked-offline-restore",
          restoreExitCode: restore.status,
          nativeReceipts: receipts,
        }),
      );
      return;
    }
    const buildFile = path.join(temporary, "build.jsonl"),
      build = invoke(
        "build",
        [
          ...common,
          "-t:Rebuild",
          "-p:RunAnalyzers=true",
          "-p:RunAnalyzersDuringBuild=true",
          `-logger:ChecktrailBuildLogger,${helper};${buildFile}`,
        ],
        workspace,
      ),
      buildEvents = await events(buildFile);
    const modules = [];
    for (const item of invocation.config.projects) {
      const base = path.join(workspace, path.dirname(item.file)),
        assembly = path.join(
          base,
          "bin/Debug/net10.0",
          item.assemblyName + ".dll",
        ),
        pdb = path.join(base, "bin/Debug/net10.0", item.assemblyName + ".pdb");
      let metadata: unknown = null;
      try {
        await regular(assembly, 32 * 1024 * 1024);
        await regular(pdb, 8 * 1024 * 1024);
        const inspection = invoke(
          "metadata:" + item.file,
          ["exec", helper, assembly, pdb],
          observer,
        );
        if (inspection.status !== 0 || inspection.stderr)
          throw Error("Native metadata unavailable");
        metadata = JSON.parse(inspection.stdout);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      modules.push({ file: item.file, assembly, pdb, metadata });
    }
    for (const event of buildEvents)
      if (
        event.type === "parameter" &&
        ["References", "Analyzers", "AnalyzerConfigFiles"].includes(
          String(event.name),
        )
      ) {
        for (const file of event.values as string[]) {
          const context = event.context as Record<string, number>,
            start = buildEvents.find(
              (e) =>
                e.type === "compilerStarted" &&
                JSON.stringify(e.context) === JSON.stringify(context),
            );
          if (start)
            await observe(path.resolve(path.dirname(String(start.file)), file));
        }
      }
    const compiledSources = new Map<
      string,
      { bytes: number; sha256: string; sha1: string }
    >();
    for (const event of buildEvents)
      if (event.type === "parameter" && event.name === "Sources") {
        const start = buildEvents.find(
          (value) =>
            value.type === "compilerStarted" &&
            JSON.stringify(value.context) === JSON.stringify(event.context),
        );
        if (start)
          for (const source of event.values as string[]) {
            const file = path.resolve(
              path.dirname(String(start.file)),
              source.replaceAll("\\", "/"),
            );
            const bytes = await regular(file, 4 * 1024 * 1024);
            if (
              !file.startsWith(workspace + path.sep) &&
              !file.startsWith(repository + path.sep)
            )
              throw Error("Compiler source outside fresh roots");
            const pin = {
              bytes: bytes.length,
              sha256: mavenHash(bytes),
              sha1: createHash("sha1").update(bytes).digest("hex"),
            };
            const previous = compiledSources.get(file);
            if (previous && JSON.stringify(previous) !== JSON.stringify(pin))
              throw Error("Compiler source changed between modules");
            compiledSources.set(file, pin);
            if (compiledSources.size > 4096)
              throw Error("Compiler source count bound");
          }
      }
    let generatedSources: Awaited<
      ReturnType<typeof collectDotnetGeneratedSources>
    >;
    try {
      generatedSources =
        build.status === 0
          ? await collectDotnetGeneratedSources({
              workspace,
              invocation,
              compiledSources,
              observe,
              regular,
            })
          : [];
    } catch (error) {
      if (!(error instanceof DotnetGeneratedScopeError)) throw error;
      process.stdout.write(
        JSON.stringify({
          version: 1,
          generatedScopeFailure: "native-output-declaration",
          buildExitCode: 0,
          nativeReceipts: receipts,
        }),
      );
      return;
    }
    const buildReceipts = [...receipts];
    const testData =
      process.argv.slice(4).includes("--test") && build.status === 0
        ? await collectDotnetTests({
            sdk,
            workspace,
            repository,
            observer,
            references: builtins,
            invocation,
            ownedPins,
            invoke,
            observe,
            regular,
            events,
          })
        : undefined;
    const formatData =
      process.argv.slice(4).includes("--format-whitespace") &&
      build.status === 0
        ? await collectDotnetFormatting({
            sdk,
            workspace,
            repository,
            observer,
            references: builtins,
            invocation,
            ownedPins,
            invoke,
            observe,
            regular,
          })
        : undefined;
    const extensionData =
      extensionConfig && build.status === 0
        ? await collectDotnetFormattingExtensions({
            sdk,
            workspace,
            repository,
            observer,
            references: builtins,
            invocation,
            config: extensionConfig,
            env,
            compiledSources,
            ownedPins,
            observe,
            regular,
          })
        : undefined;
    for (const [file, pin] of compiledSources)
      if (mavenHash(await regular(file, 4 * 1024 * 1024)) !== pin.sha256)
        throw Error("Compiler source changed after native execution");
    for (const [file, pin] of tools)
      if (JSON.stringify(await observe(file)) !== JSON.stringify(pin))
        throw Error("Native tool/input changed after build");
    for (const [file, sha256] of ownedPins)
      if (mavenHash(await readFile(file)) !== sha256)
        throw Error("Native observer/settings changed");
    for (const input of invocation.inputs)
      if (
        mavenHash(
          await readFile(await mavenLocal(root, project, input.path)),
        ) !== input.sha256 ||
        mavenHash(await readFile(path.join(workspace, input.path))) !==
          input.sha256
      )
        throw Error("Native build changed source inputs");
    await dotnetBuildRepository(root, project, invocation.config);
    await verifyMavenTree(repository, dependencies.pins.files);
    const packet = {
      version: 1,
      inputSha256: mavenHash(JSON.stringify(invocation.inputs)),
      repositoryManifest: dependencies.manifestText,
      sdkVersion: "10.0.401",
      runtimeVersion: "10.0.12",
      sdk,
      workspace,
      launcherPid: build.pid,
      restoreExitCode: restore.status,
      buildExitCode: build.status,
      restoreEvents,
      events: buildEvents,
      modules,
      nativeReceipts: buildReceipts,
      observedArtifacts: [...tools].map(([file, pin]) => ({ file, ...pin })),
      observerSha256: ownedPins.get(helper),
      generatedSources,
      compiledSources: [...compiledSources].map(([file, pin]) => ({
        file,
        ...pin,
      })),
    };
    process.stdout.write(
      JSON.stringify(
        process.argv.slice(4).includes("--test")
          ? {
              version: 1,
              build: packet,
              testObserverSha256: testData?.observerSha256 ?? "0".repeat(64),
              testObserverSourceSha256:
                testData?.observerSourceSha256 ?? "0".repeat(64),
              runs: testData?.runs ?? [],
              nativeReceipts: receipts,
            }
          : process.argv.slice(4).includes("--format-whitespace")
            ? {
                version: 1,
                build: packet,
                format: formatData ?? null,
                nativeReceipts: receipts,
              }
            : extensionFlag
              ? { version: 1, build: packet, extensions: extensionData ?? null }
              : packet,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(
    ".NET native build evidence collection could not complete\n",
  );
  process.exitCode = 2;
});
