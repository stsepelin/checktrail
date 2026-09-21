import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

export const dotnetConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetFramework: z.literal("net10.0"),
  assemblyName: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/)
    .max(128),
  languageVersion: z.enum(["12", "13", "14"]),
  outputKind: z.enum(["library", "console"]),
  nullable: z.enum(["enable", "disable", "warnings", "annotations"]),
  warningsAsErrors: z.boolean(),
  allowUnsafe: z.boolean(),
  checkedArithmetic: z.boolean(),
  implicitUsings: z.boolean(),
  defines: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(128),
    )
    .max(128)
    .refine(
      (values) =>
        new Set(values).size === values.length &&
        !values.some((value) => ["true", "false"].includes(value)),
    ),
  references: z
    .array(
      z.strictObject({
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine((value) => !/[\0\r\n]/.test(value)),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
});
export const dotnetInvocationSchema = z.strictObject({
  config: dotnetConfigSchema,
  scope: z.array(z.string().min(1)).min(1).max(20_000),
});

export async function dotnetReferences(
  root: string,
  project: string,
  config: z.infer<typeof dotnetConfigSchema>,
) {
  let total = 0;
  const files: string[] = [];
  for (const item of config.references) {
    const declared = path.resolve(root, project, item.path);
    const file = await withinRoot(root, path.relative(root, declared));
    if (file !== declared)
      throw new Error(".NET references must not traverse symbolic links");
    const info = await stat(file);
    total += info.size;
    if (
      !info.isFile() ||
      !file.endsWith(".dll") ||
      info.size > 32 * 1024 * 1024 ||
      total > 128 * 1024 * 1024
    )
      throw new Error(".NET references require bounded, local DLL files");
    if (files.includes(file)) throw new Error("Duplicate .NET reference");
    if (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== item.sha256
    )
      throw new Error(".NET reference checksum does not match");
    files.push(file);
  }
  return files;
}

export async function dotnetCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const scope = project.files.filter((file) => file.endsWith(".cs"));
  const check: Check = {
    id: "dotnet.csharp",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "dotnet-json",
    commands: [],
    reason:
      "Compile explicitly configured C# sources with native syntax/semantic accounting and pinned local references.",
  };
  try {
    if (!project.files.includes("checktrail.dotnet.json"))
      throw new Error(
        "Prepare an inventoried checktrail.dotnet.json with explicit compiler settings; MSBuild and NuGet are not invoked",
      );
    if (
      project.markers.filter((file) => file.endsWith(".csproj")).length !== 1 ||
      project.markers.some((file) => /\.(?:fsproj|vbproj)$/.test(file))
    )
      throw new Error(
        "Use one C# project per root; mixed project languages require separate profiles",
      );
    if (!scope.length) throw new Error("No C# source was inventoried");
    if (
      project.files.some((file) =>
        /\.(?:fs|fsx|vb|csx|razor|cshtml|xaml)$/.test(file),
      )
    )
      throw new Error(
        "Mixed languages, scripts and generated UI sources require separate verified profiles",
      );
    const config = dotnetConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.dotnet.json"),
        ),
      ),
    );
    await dotnetReferences(source.root, project.path, config);
    const invocation = JSON.stringify({ config, scope });
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw new Error(".NET invocation exceeds the 100 KiB argument limit");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./dotnet-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
      cwd: project.path,
      env: {
        PATH: process.env.PATH ?? "",
        DOTNET_STARTUP_HOOKS: "",
        DOTNET_ADDITIONAL_DEPS: "",
        DOTNET_SHARED_STORE: "",
        CORECLR_ENABLE_PROFILING: "0",
      },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : ".NET configuration could not be prepared";
  }
  return check;
}
