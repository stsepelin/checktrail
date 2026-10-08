import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { scalaArtifacts } from "./scala-artifacts.js";
import { scalaHash, scalaLibraries } from "./scala-archive.js";
import { kotlinRead as scalaRead } from "./kotlin-io.js";
import { kotlinJar as scalaJar } from "./kotlin-jar.js";
import type { Check, Inventory, Project } from "./types.js";
const dependency = z.strictObject({
  path: externalPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const scalaConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archive: externalPathSchema,
  sha256: z.literal(scalaArtifacts.archiveSha256),
  profile: z.literal(scalaArtifacts.profile),
  jvmTarget: z.enum(["17", "21", "25"]),
  warningsAsErrors: z.boolean(),
  classPath: z.array(dependency).max(128),
});
export const scalaInvocationSchema = z.strictObject({
  config: scalaConfigSchema,
  scope: z.array(externalPathSchema).min(1).max(2000),
});
export async function scalaInputs(
  root: string,
  project: string,
  config: z.infer<typeof scalaConfigSchema>,
) {
  const declared = path.resolve(root, project, config.archive),
    archive = await withinRoot(root, path.relative(root, declared)),
    metadata = await stat(archive);
  if (
    archive !== declared ||
    !metadata.isFile() ||
    metadata.size !== scalaArtifacts.archiveBytes
  )
    throw Error(
      "Prepare the pinned Scala compiler archive without symbolic links",
    );
  const bytes = await scalaRead(archive, scalaArtifacts.archiveBytes),
    libraries = scalaLibraries(bytes);
  if (scalaHash(bytes) !== config.sha256)
    throw Error("Pinned Scala compiler archive identity disagrees");
  for (const library of scalaArtifacts.runtimeLibraries) {
    const actual = scalaJar(libraries.get(library.name)!);
    if (actual.classPath.length)
      throw Error("Scala native runtime has undeclared manifest dependencies");
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
      throw Error("Prepare a bounded regular pinned Scala dependency JAR");
    const payload = await scalaRead(file, 32 * 1024 * 1024);
    if (scalaJar(payload).classPath.length)
      throw Error("Scala dependency JAR has undeclared manifest classpath");
    total += payload.length;
    if (
      total > 64 * 1024 * 1024 ||
      scalaHash(payload) !== declaredDependency.sha256
    )
      throw Error("Scala dependency bytes disagree with their declared pins");
    dependencies.push({
      file,
      bytes: payload,
      sha256: declaredDependency.sha256,
    });
  }
  if (new Set(dependencies.map((d) => d.file)).size !== dependencies.length)
    throw Error("Duplicate Scala classpath dependency");
  return { archive, bytes, libraries, dependencies };
}
export async function scalaCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "jvm.scala",
    adapter: project.adapter,
    project: project.path,
    scope: project.files.filter((file) => file.endsWith(".scala")),
    kind: "analysis",
    parser: "scala-json",
    commands: [],
    reason:
      "Compile selected Scala JVM source using pinned compiler/runtime libraries, native typed-tree/backend participation, exact suppressions and output/source bindings. Scripts and mixed source compilation remain separate.",
  };
  try {
    if (!project.files.includes("checktrail.scala.json"))
      throw Error(
        "Prepare an inventoried checktrail.scala.json and local pinned compiler archive",
      );
    if (!check.scope.length) throw Error("No Scala source was inventoried");
    if (project.files.some((file) => file.endsWith(".sc")))
      throw Error("Scala scripts require a separate compiler profile");
    if (project.files.some((file) => /\.(?:java|kt|kts)$/.test(file)))
      throw Error("Mixed JVM source compilation requires a separate profile");
    if (
      check.scope.length > 2000 ||
      new Set(check.scope).size !== check.scope.length
    )
      throw Error("Scala source inventory exceeds the declared profile");
    const config = scalaConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.scala.json"),
        ),
      ),
    );
    await scalaInputs(source.root, project.path, config);
    const invocation = JSON.stringify(
      scalaInvocationSchema.parse({ config, scope: check.scope }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw Error("Scala invocation exceeds its 100 KiB bound");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./scala-runner.js", import.meta.url)),
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
      },
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "Scala compiler prerequisites unavailable";
  }
  return check;
}
