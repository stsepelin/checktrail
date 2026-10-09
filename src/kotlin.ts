import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { kotlinArtifacts } from "./kotlin-artifacts.js";
import { kotlinHash, kotlinLibraries } from "./kotlin-archive.js";
import { kotlinRead } from "./kotlin-io.js";
import { kotlinJar } from "./kotlin-jar.js";
import { kotlinScriptingArtifacts } from "./kotlin-extension-artifacts.js";
import {
  kotlinExtensionsSchema,
  validateKotlinExtensionScope,
} from "./kotlin-extensions.js";
import { verifyJvmToolchain } from "./jvm-extensions.js";
import type { Check, Inventory, Project } from "./types.js";
const dependency = z.strictObject({
  path: externalPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const kotlinConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archive: externalPathSchema,
  sha256: z.literal(kotlinArtifacts.archiveSha256),
  profile: z.literal(kotlinArtifacts.profile),
  jvmTarget: z.enum(["17", "21", "25"]),
  warningsAsErrors: z.boolean(),
  classPath: z.array(dependency).max(128),
  extensions: kotlinExtensionsSchema.optional(),
});
export const kotlinInvocationSchema = z.strictObject({
  config: kotlinConfigSchema,
  scope: z.array(externalPathSchema).min(1).max(2000),
});
export async function kotlinInputs(
  root: string,
  project: string,
  config: z.infer<typeof kotlinConfigSchema>,
) {
  const declared = path.resolve(root, project, config.archive),
    archive = await withinRoot(root, path.relative(root, declared)),
    metadata = await stat(archive);
  if (
    archive !== declared ||
    !metadata.isFile() ||
    metadata.size !== kotlinArtifacts.archiveBytes
  )
    throw Error(
      "Prepare the pinned Kotlin compiler archive without symbolic links",
    );
  const bytes = await kotlinRead(archive, kotlinArtifacts.archiveBytes),
    libraries = kotlinLibraries(bytes, config.extensions !== undefined);
  if (kotlinHash(bytes) !== config.sha256)
    throw Error("Pinned Kotlin compiler archive identity disagrees");
  for (const library of [
    ...kotlinArtifacts.runtimeLibraries,
    ...(config.extensions ? kotlinScriptingArtifacts : []),
  ]) {
    const actual = kotlinJar(libraries.get(library.name)!);
    const expected =
      library.name === "kotlin-compiler.jar"
        ? [...kotlinArtifacts.compilerManifestClassPath]
        : [];
    if (JSON.stringify(actual.classPath) !== JSON.stringify(expected))
      throw Error("Kotlin runtime manifest dependency closure disagrees");
  }
  const dependencies = [];
  let total = 0;
  for (const declaredDependency of config.classPath) {
    const declaredPath = path.resolve(root, project, declaredDependency.path),
      file = await withinRoot(root, path.relative(root, declaredPath)),
      info = await stat(file);
    if (
      file !== declaredPath ||
      !info.isFile() ||
      info.size > 32 * 1024 * 1024 ||
      !file.endsWith(".jar")
    )
      throw Error("Prepare a bounded regular pinned Kotlin dependency JAR");
    const payload = await kotlinRead(file, 32 * 1024 * 1024);
    if (kotlinJar(payload).classPath.length)
      throw Error("Kotlin dependency JAR has undeclared manifest classpath");
    total += payload.length;
    if (
      total > 64 * 1024 * 1024 ||
      kotlinHash(payload) !== declaredDependency.sha256
    )
      throw Error("Kotlin dependency bytes disagree with their declared pins");
    dependencies.push({
      file,
      bytes: payload,
      sha256: declaredDependency.sha256,
    });
  }
  if (new Set(dependencies.map((d) => d.file)).size !== dependencies.length)
    throw Error("Duplicate Kotlin classpath dependency");
  return { archive, bytes, libraries, dependencies };
}
export async function kotlinCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "jvm.kotlin",
    adapter: project.adapter,
    project: project.path,
    scope: project.files.filter((file) => file.endsWith(".kt")),
    kind: "analysis",
    parser: "kotlin-json",
    commands: [],
    reason:
      "Compile selected Kotlin JVM source using pinned compiler/runtime libraries, native frontend/IR participation, exact suppressions and output/source bindings. Scripts and mixed source compilation remain separate.",
  };
  try {
    if (!project.files.includes("checktrail.kotlin.json"))
      throw Error(
        "Prepare an inventoried checktrail.kotlin.json and local pinned compiler archive",
      );
    const config = kotlinConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.kotlin.json"),
        ),
      ),
    );
    const scripts = project.files.filter(
      (file) =>
        file.endsWith(".kts") &&
        !["build.gradle.kts", "settings.gradle.kts"].includes(
          path.posix.basename(file),
        ),
    );
    if (config.extensions) {
      check.scope = project.files.filter(
        (file) =>
          file.endsWith(".kt") ||
          file.endsWith(".java") ||
          scripts.includes(file),
      );
      validateKotlinExtensionScope(config.extensions, check.scope);
      await verifyJvmToolchain();
      check.reason =
        "Compile declared mixed Java/Kotlin, fresh generated Kotlin and compile-only scripts with native source, class origin and diagnostic accounting.";
    } else {
      if (scripts.length)
        throw Error(
          "Kotlin scripts require a separately declared compiler profile",
        );
      if (project.files.some((file) => /\.(?:java|scala)$/.test(file)))
        throw Error("Mixed JVM source compilation requires a separate profile");
    }
    if (project.files.some((file) => file.endsWith(".scala")))
      throw Error("Mixed Scala compilation is outside this Kotlin profile");
    if (
      !check.scope.length ||
      check.scope.length > 2000 ||
      new Set(check.scope).size !== check.scope.length
    )
      throw Error(
        "Kotlin source inventory exceeds the declared nonempty profile",
      );
    await kotlinInputs(source.root, project.path, config);
    const invocation = JSON.stringify(
      kotlinInvocationSchema.parse({ config, scope: check.scope }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw Error("Kotlin invocation exceeds its 100 KiB bound");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(
          new URL(
            config.extensions
              ? "./kotlin-extensions-runner.js"
              : "./kotlin-runner.js",
            import.meta.url,
          ),
        ),
        source.root,
        invocation,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        PATH: process.env.PATH ?? "",
        JAVA_TOOL_OPTIONS: "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
        CLASSPATH: "",
        ...(config.extensions ? { KOTLIN_HOME: "", KOTLIN_RUNNER: "" } : {}),
      },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "Kotlin compiler prerequisites unavailable";
  }
  return check;
}
