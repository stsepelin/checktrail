import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readProjectFile, withinRoot } from "./inventory.js";
import type { Check, Inventory, Project } from "./types.js";

export const javaConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  release: z.number().int().min(8).max(25),
  warningsAsErrors: z.boolean(),
  classPath: z
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
export const javaInvocationSchema = z.strictObject({
  config: javaConfigSchema,
  scope: z.array(z.string().min(1)).min(1).max(20_000),
});

export async function javaDependencies(
  root: string,
  project: string,
  config: z.infer<typeof javaConfigSchema>,
) {
  let total = 0;
  const files: string[] = [];
  for (const item of config.classPath) {
    const declared = path.resolve(root, project, item.path);
    const file = await withinRoot(root, path.relative(root, declared));
    if (declared !== file)
      throw new Error("Java dependencies must not traverse symbolic links");
    const info = await stat(file);
    total += info.size;
    if (
      !info.isFile() ||
      !file.endsWith(".jar") ||
      info.size > 32 * 1024 * 1024 ||
      total > 128 * 1024 * 1024
    )
      throw new Error("Java dependencies require bounded, local JAR files");
    if (files.includes(file))
      throw new Error("Duplicate Java classpath dependency");
    if (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== item.sha256
    )
      throw new Error("Java dependency checksum does not match");
    files.push(file);
  }
  return files;
}

export async function javaCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const scope = project.files.filter((file) => file.endsWith(".java"));
  const check: Check = {
    id: "jvm.javac",
    adapter: project.adapter,
    project: project.path,
    scope,
    kind: "analysis",
    parser: "java-json",
    commands: [],
    reason:
      "Compile explicitly configured Java sources with annotation processing disabled and native parse/analysis accounting.",
  };
  try {
    if (!project.files.includes("checktrail.java.json"))
      throw new Error(
        "Prepare an inventoried checktrail.java.json with a release and pinned classpath; Maven and Gradle are not invoked",
      );
    if (!scope.length) throw new Error("No Java source was inventoried");
    if (scope.some((file) => path.posix.basename(file) === "module-info.java"))
      throw new Error(
        "Java modules require a separate verified module-path profile",
      );
    if (
      project.files.some(
        (file) =>
          /\.(?:kt|kts|scala)$/.test(file) &&
          !["build.gradle.kts", "settings.gradle.kts"].includes(
            path.posix.basename(file),
          ),
      )
    )
      throw new Error(
        "Mixed JVM language projects require a separate compiler profile",
      );
    const config = javaConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.java.json"),
        ),
      ),
    );
    await javaDependencies(source.root, project.path, config);
    const invocation = JSON.stringify({ config, scope });
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw new Error("Java invocation exceeds the 100 KiB argument limit");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./java-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
      cwd: project.path,
      env: {
        PATH: process.env.PATH ?? "",
        JAVA_TOOL_OPTIONS: "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
        CLASSPATH: "",
      },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "Java configuration could not be prepared";
  }
  return check;
}
