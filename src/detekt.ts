import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { detektArtifacts } from "./detekt-artifacts.js";
import { detektConfiguration, detektHash } from "./detekt-configuration.js";
import type { Check, Inventory, Project } from "./types.js";

export const detektConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jar: externalPathSchema,
  sha256: z.literal(detektArtifacts.jarSha256),
  profile: z.literal("core-default-light-all-selected-v1"),
});
export const detektInvocationSchema = z.strictObject({
  config: detektConfigSchema,
  configurationSha256: z.literal(detektArtifacts.configurationSha256),
  scope: z.array(externalPathSchema).min(1).max(2000),
});
export async function detektInputs(
  root: string,
  project: string,
  config: z.infer<typeof detektConfigSchema>,
) {
  const declared = path.resolve(root, project, config.jar),
    jar = await withinRoot(root, path.relative(root, declared)),
    info = await stat(jar);
  if (
    jar !== declared ||
    !info.isFile() ||
    info.size !== detektArtifacts.jarBytes
  )
    throw Error("Prepare the exact pinned detekt JAR without symbolic links");
  const bytes = await readFile(jar);
  if (detektHash(bytes) !== config.sha256)
    throw Error("Pinned detekt artifact checksum does not match");
  return { jar, bytes, configuration: detektConfiguration(bytes) };
}
export async function detektCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "jvm.detekt",
    adapter: project.adapter,
    project: project.path,
    scope: project.files.filter((file) => /\.(?:kt|kts)$/.test(file)),
    kind: "analysis",
    parser: "detekt-json",
    commands: [],
    reason:
      "Analyze every selected Kotlin file with pinned built-in light rules and native source, rule, suppression and lifecycle accounting; type compilation remains separate.",
  };
  try {
    if (!project.files.includes("checktrail.detekt.json"))
      throw Error(
        "Prepare an inventoried checktrail.detekt.json and pinned local analyzer JAR",
      );
    if (!check.scope.length) throw Error("No Kotlin source was inventoried");
    if (
      check.scope.length > 2000 ||
      new Set(check.scope).size !== check.scope.length ||
      check.scope.some((file) => /[:;\r\n\0]/.test(file))
    )
      throw Error("Kotlin scope exceeds the explicit native file-list profile");
    const config = detektConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.detekt.json"),
        ),
      ),
    );
    await detektInputs(source.root, project.path, config);
    const invocation = JSON.stringify(
      detektInvocationSchema.parse({
        config,
        configurationSha256: detektArtifacts.configurationSha256,
        scope: check.scope,
      }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw Error("detekt invocation exceeds its 100 KiB bound");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./detekt-runner.js", import.meta.url)),
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
        : "detekt prerequisites unavailable";
  }
  return check;
}
