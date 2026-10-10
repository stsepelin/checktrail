import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { withinRoot } from "./inventory.js";
import { kotlinRead } from "./kotlin-io.js";
import { kotlinJar } from "./kotlin-jar.js";
import { scala2Artifacts } from "./scala2-artifacts.js";
import { scala2Hash, scala2Libraries } from "./scala2-archive.js";
export const scala2ConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archive: externalPathSchema,
  sha256: z.literal(scala2Artifacts.archiveSha256),
  profile: z.literal(scala2Artifacts.profile),
  jvmTarget: z.enum(["17", "21", "25"]),
  warningsAsErrors: z.boolean(),
  classPath: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(128),
});
export async function scala2Inputs(
  root: string,
  project: string,
  config: z.infer<typeof scala2ConfigSchema>,
) {
  const declared = path.resolve(root, project, config.archive),
    archive = await withinRoot(root, path.relative(root, declared)),
    metadata = await stat(archive);
  if (
    archive !== declared ||
    !metadata.isFile() ||
    metadata.size !== scala2Artifacts.archiveBytes
  )
    throw Error("Prepare the exact pinned regular Scala 2 archive");
  const bytes = await kotlinRead(archive, scala2Artifacts.archiveBytes),
    libraries = scala2Libraries(bytes);
  if (scala2Hash(bytes) !== config.sha256)
    throw Error("Scala 2 compiler archive pin disagrees");
  for (const library of scala2Artifacts.runtimeLibraries) {
    const actual = kotlinJar(
      libraries.get(library.name)!,
      library.name === "scala-library.jar" ? 256 * 1024 : 65536,
    );
    const expected =
      library.name === "scala-compiler.jar"
        ? ["scala-reflect.jar", "scala-library.jar"]
        : [];
    if (JSON.stringify(actual.classPath) !== JSON.stringify(expected))
      throw Error("Scala 2 runtime manifest dependencies disagree");
  }
  const dependencies = [];
  let total = 0;
  for (const dep of config.classPath) {
    const declaredFile = path.resolve(root, project, dep.path),
      file = await withinRoot(root, path.relative(root, declaredFile)),
      info = await stat(file);
    if (
      file !== declaredFile ||
      !info.isFile() ||
      !file.endsWith(".jar") ||
      info.size > 32 * 1024 * 1024
    )
      throw Error("Prepare a bounded regular pinned Scala 2 dependency JAR");
    const payload = await kotlinRead(file, 32 * 1024 * 1024);
    total += payload.length;
    if (
      total > 64 * 1024 * 1024 ||
      scala2Hash(payload) !== dep.sha256 ||
      kotlinJar(payload).classPath.length
    )
      throw Error("Scala 2 dependency identity or manifest closure disagrees");
    dependencies.push({ file, bytes: payload, sha256: dep.sha256 });
  }
  if (new Set(dependencies.map((d) => d.file)).size !== dependencies.length)
    throw Error("Duplicate Scala 2 dependency");
  return { archive, bytes, libraries, dependencies };
}
