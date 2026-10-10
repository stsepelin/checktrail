import path from "node:path";
import { createHash } from "node:crypto";
import { withinRoot } from "./inventory.js";
import { externalPathSchema } from "./external-schema.js";
import { kotlinRead } from "./kotlin-io.js";
import { kotlinJar } from "./kotlin-jar.js";
import { verifySpotbugsPluginMetadata } from "./spotbugs-plugin-jar.js";
import type { SpotbugsExtensions } from "./spotbugs-extensions.js";
export const spotbugsHash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function spotbugsExtensionPlugins(
  root: string,
  project: string,
  extensions: SpotbugsExtensions,
) {
  let total = 0;
  const result = [];
  for (const plugin of extensions.plugins) {
    const declared = path.resolve(root, project, plugin.path),
      file = await withinRoot(root, path.relative(root, declared));
    if (declared !== file)
      throw Error("Plugin paths cannot traverse symbolic links");
    const bytes = await kotlinRead(file, 32 * 1024 * 1024);
    total += bytes.length;
    if (total > 128 * 1024 * 1024 || spotbugsHash(bytes) !== plugin.sha256)
      throw Error("Plugin byte identity or aggregate bound disagrees");
    const metadata = verifySpotbugsPluginMetadata(bytes, plugin);
    result.push({ file, bytes, metadata });
  }
  return result;
}
export async function spotbugsExtensionLibraries(
  root: string,
  project: string,
  dependencies: Array<{ path: string; sha256: string }>,
) {
  if (
    dependencies.some(
      (d) =>
        !externalPathSchema.safeParse(d.path).success ||
        !d.path.endsWith(".jar") ||
        /[:;\r\n\0]/.test(d.path),
    ) ||
    new Set(dependencies.map((d) => d.path)).size !== dependencies.length
  )
    throw Error("Analyzer dependencies require unique plain bounded JAR paths");
  let total = 0;
  const result = [];
  for (const dependency of dependencies) {
    const declared = path.resolve(root, project, dependency.path),
      file = await withinRoot(root, path.relative(root, declared));
    if (declared !== file)
      throw Error("Analyzer libraries cannot traverse symbolic links");
    const bytes = await kotlinRead(file, 32 * 1024 * 1024);
    total += bytes.length;
    if (
      total > 128 * 1024 * 1024 ||
      spotbugsHash(bytes) !== dependency.sha256 ||
      kotlinJar(bytes).classPath.length
    )
      throw Error(
        "Analyzer library identity, implicit classpath or aggregate bound disagrees",
      );
    result.push({ file, bytes });
  }
  return result;
}
