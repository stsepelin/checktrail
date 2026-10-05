import path from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal, verifyMavenTree } from "./maven.js";
import type { Check, Inventory, Project } from "./types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const dotnetBuildRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(32 * 1024 * 1024),
        sha256: digest,
      }),
    )
    .min(1)
    .max(4096),
});
export const dotnetBuildConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  solution: externalPathSchema,
  repository: externalPathSchema,
  repositoryManifest: externalPathSchema,
  repositorySha256: digest,
  projects: z
    .array(
      z.strictObject({
        file: externalPathSchema,
        language: z.enum(["csharp", "fsharp", "visual-basic"]),
        assemblyName: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
          .max(128),
        targetFramework: z.literal("net10.0"),
        kind: z.enum(["library", "test"]),
        sources: z.array(externalPathSchema).min(1).max(2048),
        generatedSources: z.array(externalPathSchema).max(256),
        testClasses: z
          .array(
            z.strictObject({
              file: externalPathSchema,
              className: z
                .string()
                .regex(/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/),
            }),
          )
          .max(256),
      }),
    )
    .min(1)
    .max(64),
});
export const dotnetBuildInvocationSchema = z.strictObject({
  config: dotnetBuildConfigSchema,
  inputs: z
    .array(z.strictObject({ path: externalPathSchema, sha256: digest }))
    .min(1)
    .max(2048),
});
export const dotnetBuildProtectedEnvironment = [
  "HOME",
  "DOTNET_CLI_HOME",
  "DOTNET_HOST_PATH",
  "DOTNET_ROOT",
  "DOTNET_ROOT_ARM64",
  "DOTNET_ROOT_X64",
  "DOTNET_ROLL_FORWARD",
  "DOTNET_STARTUP_HOOKS",
  "DOTNET_ADDITIONAL_DEPS",
  "DOTNET_SHARED_STORE",
  "DOTNET_CLI_USE_MSBUILD_SERVER",
  "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT",
  "MSBuildSDKsPath",
  "MSBUILD_EXE_PATH",
  "MSBUILDNOINPROCNODE",
  "MSBUILDDISABLENODEREUSE",
  "NUGET_PACKAGES",
  "NUGET_HTTP_CACHE_PATH",
  "NUGET_SCRATCH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "ENV",
  "BASH_ENV",
];
export class DotnetBuildPrerequisiteError extends Error {}
export async function dotnetBuildRepository(
  root: string,
  project: string,
  config: z.infer<typeof dotnetBuildConfigSchema>,
) {
  try {
    const repository = await mavenLocal(root, project, config.repository),
      manifest = await mavenLocal(root, project, config.repositoryManifest),
      info = await lstat(manifest);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw Error("Manifest bound");
    const bytes = await readFile(manifest);
    if (
      bytes.length > 1024 * 1024 ||
      mavenHash(bytes) !== config.repositorySha256
    )
      throw Error("Manifest identity");
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes,
      ),
      pins = dotnetBuildRepositorySchema.parse(JSON.parse(manifestText));
    await verifyMavenTree(repository, pins.files);
    return { repository, manifestText, pins };
  } catch {
    throw new DotnetBuildPrerequisiteError(
      "Prepare bounded regular .NET dependency artifacts and an exact manifest without links",
    );
  }
}
const extensions = {
  csharp: "cs",
  fsharp: "fs",
  "visual-basic": "vb",
} as const;
export async function dotnetBuildCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const prefix = project.path === "." ? "" : project.path + "/",
    inputs = source.files
      .filter(
        (file) =>
          file.startsWith(prefix) &&
          !/(?:^|\/)(?:bin|obj)\//.test(file.slice(prefix.length)),
      )
      .map((file) => file.slice(prefix.length));
  const check: Check = {
    id: "dotnet.build",
    adapter: project.adapter,
    project: project.path,
    scope: inputs.filter((file) => /\.(?:cs|fs|vb)$/.test(file)),
    kind: "analysis",
    parser: "dotnet-build-json",
    commands: [],
    reason:
      "Build the complete declared C#/F#/VB scope in fresh outputs with offline locked dependencies and native compiler participation.",
  };
  try {
    if (!project.files.includes("checktrail.dotnet-build.json"))
      throw new DotnetBuildPrerequisiteError(
        "Prepare an inventoried checktrail.dotnet-build.json with complete project, source and dependency scope",
      );
    const config = dotnetBuildConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.dotnet-build.json"),
        ),
      ),
    );
    const declared = config.projects.map((item) => item.file),
      actual = inputs.filter((file) =>
        /\.(?:csproj|fsproj|vbproj)$/.test(file),
      );
    if (
      new Set(declared).size !== declared.length ||
      JSON.stringify([...declared].sort()) !== JSON.stringify(actual.sort())
    )
      throw new DotnetBuildPrerequisiteError(
        "Declare every inventoried .NET project exactly once",
      );
    if (
      !inputs.includes(config.solution) ||
      !/\.(?:slnx|sln|csproj|fsproj|vbproj)$/.test(config.solution)
    )
      throw new DotnetBuildPrerequisiteError(
        "Select an inventoried project or solution",
      );
    if (inputs.some((file) => /\.(?:csx|fsx|razor|cshtml|xaml)$/.test(file)))
      throw new DotnetBuildPrerequisiteError(
        "Scripts and UI generation require additional verified .NET profiles",
      );
    const assigned = config.projects.flatMap((item) => item.sources);
    if (
      new Set(assigned).size !== assigned.length ||
      JSON.stringify([...assigned].sort()) !==
        JSON.stringify([...check.scope].sort())
    )
      throw new DotnetBuildPrerequisiteError(
        "Declare every inventoried C#/F#/VB source exactly once",
      );
    for (const item of config.projects) {
      const extension = extensions[item.language],
        directory = path.posix.dirname(item.file);
      if (
        !item.file.endsWith("." + extension + "proj") ||
        item.sources.some(
          (file) =>
            !file.endsWith("." + extension) ||
            path.posix.relative(directory, file).startsWith("../"),
        )
      )
        throw new DotnetBuildPrerequisiteError(
          "Project language and conventional source boundaries must agree",
        );
      if (
        new Set(item.generatedSources).size !== item.generatedSources.length ||
        item.generatedSources.some(
          (file) =>
            !file.startsWith(path.posix.join(directory, "obj") + "/") ||
            !file.endsWith("." + extension),
        )
      )
        throw new DotnetBuildPrerequisiteError(
          "Declare generated sources inside their fresh project obj tree",
        );
      if (
        (item.kind === "library" && item.testClasses.length) ||
        (item.kind === "test" && !item.testClasses.length) ||
        new Set(item.testClasses.map((value) => value.className)).size !==
          item.testClasses.length ||
        item.testClasses.some((value) => !item.sources.includes(value.file))
      )
        throw new DotnetBuildPrerequisiteError(
          "Test class roles must bind to unique declared source inputs",
        );
      if (!inputs.includes(path.posix.join(directory, "packages.lock.json")))
        throw new DotnetBuildPrerequisiteError(
          "Prepare an inventoried package lock for every declared project",
        );
    }
    await dotnetBuildRepository(source.root, project.path, config);
    const pins = [];
    for (const file of inputs) {
      const bytes = await readFile(
        await mavenLocal(source.root, project.path, file),
      );
      if (bytes.length > 4 * 1024 * 1024)
        throw new DotnetBuildPrerequisiteError(
          ".NET source input exceeds its bound",
        );
      pins.push({ path: file, sha256: mavenHash(bytes) });
    }
    const invocation = dotnetBuildInvocationSchema.parse({
        config,
        inputs: pins,
      }),
      serialized = JSON.stringify(invocation);
    if (Buffer.byteLength(serialized) > 100 * 1024)
      throw new DotnetBuildPrerequisiteError(
        ".NET invocation exceeds its bound",
      );
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./dotnet-build-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: Object.fromEntries(
        dotnetBuildProtectedEnvironment
          .map((name) => [name, ""])
          .concat([["PATH", process.env.PATH ?? ""]]),
      ),
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof DotnetBuildPrerequisiteError
        ? error.message
        : ".NET build prerequisites are invalid or unsupported";
  }
  return check;
}

export async function dotnetTestCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check = await dotnetBuildCheck(source, project);
  check.id = "dotnet.test";
  check.kind = "test";
  check.parser = "dotnet-test-json";
  check.reason =
    "Build fresh C#/F#/VB outputs and reconcile every declared native test with discovery, portable symbols, execution and TRX.";
  if (check.commands.length) {
    const invocation = dotnetBuildInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    );
    if (
      !invocation.config.projects.some((project) => project.kind === "test")
    ) {
      check.commands = [];
      check.unavailableReason =
        "Declare a supported .NET test project and source-bound test classes";
    } else check.commands[0]!.args.push("--test");
  }
  return check;
}
