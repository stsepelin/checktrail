import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { javaCheck, javaDependencies, javaConfigSchema } from "./java.js";
import { spotbugsArtifacts } from "./spotbugs-artifacts.js";
import {
  spotbugsExtensionsSchema,
  validateSpotbugsExtensionScope,
} from "./spotbugs-extensions.js";
import {
  spotbugsExtensionPlugins,
  spotbugsExtensionLibraries,
} from "./spotbugs-extensions-inputs.js";
import { verifyJvmToolchain } from "./jvm-extensions.js";
import type { Check, Inventory, Project } from "./types.js";
export const SPOTBUGS_VERSION = spotbugsArtifacts.version;
const spotbugsBaseConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archive: externalPathSchema,
  sha256: z.literal(spotbugsArtifacts.archiveSha256),
  profile: z.literal("core-default-max-v1"),
});
export const spotbugsConfigSchema = z.discriminatedUnion("profile", [
  spotbugsBaseConfigSchema,
  spotbugsBaseConfigSchema.extend({
    profile: z.literal("core-default-max-class-scopes-plugins-v1"),
    extensions: spotbugsExtensionsSchema,
  }),
]);
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
    const extended =
      config.profile === "core-default-max-class-scopes-plugins-v1";
    let java: { config: z.infer<typeof javaConfigSchema> };
    if (extended) {
      if (
        !project.files.includes("checktrail.java.json") ||
        project.files.some(
          (file) =>
            /\.(?:kt|kts|scala)$/.test(file) &&
            !["build.gradle.kts", "settings.gradle.kts"].includes(
              path.posix.basename(file),
            ),
        )
      )
        throw Error(
          "Analyzer compiler cohorts require explicit Java configuration and selected Java sources",
        );
      java = {
        config: javaConfigSchema.parse(
          JSON.parse(
            await readProjectFile(
              source.root,
              path.posix.join(project.path, "checktrail.java.json"),
            ),
          ),
        ),
      };
      validateSpotbugsExtensionScope(config.extensions, check.scope);
      if (
        config.extensions.jpms.length &&
        (java.config.release < 9 || java.config.classPath.length)
      )
        throw Error(
          "Named analyzer cohorts require release 9 or newer and declared fresh module dependencies; external module JARs need a separate profile",
        );
      await spotbugsExtensionPlugins(
        source.root,
        project.path,
        config.extensions,
      );
      await spotbugsExtensionLibraries(
        source.root,
        project.path,
        java.config.classPath,
      );
      await verifyJvmToolchain();
      check.reason =
        "Compile explicit fresh application and library cohorts, inspect generated and named-module identities, and analyze selected classes with current native rule provenance.";
    } else {
      if (compiler.unavailableReason) throw Error(compiler.unavailableReason);
      java = JSON.parse(compiler.commands[0]!.args[2]!) as {
        config: z.infer<typeof javaConfigSchema>;
      };
    }
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
      executable: process.execPath,
      cwd: project.path,
      env: {
        PATH: process.env.PATH ?? "",
        JAVA_TOOL_OPTIONS: "",
        JDK_JAVA_OPTIONS: "",
        _JAVA_OPTIONS: "",
        CLASSPATH: "",
      },
      temporaryDirectory: true,
      args: [
        fileURLToPath(
          new URL(
            extended
              ? "./spotbugs-extensions-runner.js"
              : "./spotbugs-runner.js",
            import.meta.url,
          ),
        ),
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
