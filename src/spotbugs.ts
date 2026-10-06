import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { javaCheck, javaDependencies, javaConfigSchema } from "./java.js";
import { spotbugsArtifacts } from "./spotbugs-artifacts.js";
import type { Check, Inventory, Project } from "./types.js";
export const SPOTBUGS_VERSION = spotbugsArtifacts.version;
export const spotbugsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archive: externalPathSchema,
  sha256: z.literal(spotbugsArtifacts.archiveSha256),
  profile: z.literal("core-default-max-v1"),
});
export const spotbugsInvocationSchema = z.strictObject({
  config: spotbugsConfigSchema,
  compiler: javaConfigSchema,
  scope: z.array(externalPathSchema).min(1).max(20_000),
});
export async function spotbugsInputs(
  root: string,
  project: string,
  config: z.infer<typeof spotbugsConfigSchema>,
) {
  const declared = path.resolve(root, project, config.archive);
  const file = await withinRoot(root, path.relative(root, declared));
  const info = await stat(file);
  if (file !== declared || !info.isFile() || info.size !== 15831983)
    throw Error(
      "Prepare the pinned SpotBugs 4.10.4 archive without symbolic links",
    );
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== config.sha256)
    throw Error("SpotBugs archive checksum does not match");
  return bytes;
}
export async function spotbugsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const compiler = await javaCheck(source, project);
  const check: Check = {
    id: "jvm.spotbugs",
    adapter: project.adapter,
    project: project.path,
    scope: compiler.scope,
    kind: "analysis",
    parser: "spotbugs-json",
    commands: [],
    reason:
      "Compile selected current Java sources without annotation processing and run the pinned built-in SpotBugs default detectors with native class and pass accounting.",
  };
  try {
    if (compiler.unavailableReason) throw Error(compiler.unavailableReason);
    if (!project.files.includes("checktrail.spotbugs.json"))
      throw Error(
        "Prepare an inventoried checktrail.spotbugs.json and pinned local distribution",
      );
    const config = spotbugsConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.spotbugs.json"),
        ),
      ),
    );
    const java = JSON.parse(compiler.commands[0]!.args[2]!) as {
      config: z.infer<typeof javaConfigSchema>;
    };
    await javaDependencies(source.root, project.path, java.config);
    await spotbugsInputs(source.root, project.path, config);
    const invocation = JSON.stringify(
      spotbugsInvocationSchema.parse({
        config,
        compiler: java.config,
        scope: check.scope,
      }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw Error("SpotBugs invocation exceeds its 100 KiB bound");
    check.commands.push({
      ...compiler.commands[0]!,
      temporaryDirectory: true,
      args: [
        fileURLToPath(new URL("./spotbugs-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof Error
        ? error.message
        : "SpotBugs prerequisites could not be prepared";
  }
  return check;
}
