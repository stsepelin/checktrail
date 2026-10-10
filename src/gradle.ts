import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile } from "./inventory.js";
import {
  mavenHash,
  mavenLocal,
  mavenRepositorySchema,
  verifyMavenTree,
} from "./maven.js";
import { gradleDistributionFiles } from "./gradle-distribution.js";
import {
  jvmExtensionsSchema,
  jvmGeneratorSourceFiles,
  jvmWrapperSourceFiles,
  validateJvmExtensionScope,
  verifyJvmWrapper,
  verifyJvmToolchain,
} from "./jvm-extensions.js";
import type { Check, Inventory, Project } from "./types.js";

export const gradleConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  extensions: jvmExtensionsSchema.optional(),
  distribution: externalPathSchema,
  repository: externalPathSchema,
  repositoryManifest: externalPathSchema,
  repositorySha256: z.string().regex(/^[a-f0-9]{64}$/),
  modules: z
    .array(
      z.strictObject({
        path: z.union([z.literal("."), externalPathSchema]),
        kind: z.enum(["aggregator", "java"]),
        testClasses: z
          .array(
            z.strictObject({
              file: externalPathSchema,
              className: z
                .string()
                .regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/),
            }),
          )
          .max(256),
        supportTests: z.array(externalPathSchema).max(256),
      }),
    )
    .min(1)
    .max(64),
});
export const gradleInvocationSchema = z.strictObject({
  config: gradleConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(2048),
});
export const gradleProtectedEnvironment = [
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "JAVA_OPTS",
  "GRADLE_OPTS",
  "GRADLE_USER_HOME",
  "GRADLE_HOME",
  "JAVA_HOME",
  "HOME",
  "ENV",
  "BASH_ENV",
  "JAVACMD",
  "CDPATH",
];
export class GradlePrerequisiteError extends Error {}
export async function gradleTools(
  root: string,
  project: string,
  config: z.infer<typeof gradleConfigSchema>,
) {
  try {
    const distribution = await mavenLocal(root, project, config.distribution),
      repository = await mavenLocal(root, project, config.repository),
      manifest = await mavenLocal(root, project, config.repositoryManifest);
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 1024 * 1024)
      throw Error("Manifest byte bound");
    const bytes = await readFile(manifest);
    if (
      bytes.length > 1024 * 1024 ||
      mavenHash(bytes) !== config.repositorySha256
    )
      throw Error("Manifest pin");
    const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes,
      ),
      pins = mavenRepositorySchema.parse(JSON.parse(manifestText));
    await verifyMavenTree(distribution, gradleDistributionFiles);
    await verifyMavenTree(repository, pins.files);
    for (const role of ["launcher", "engine", "commons"])
      if (
        !pins.files.some(
          (file) =>
            file.path ===
            `org/junit/platform/junit-platform-${role}/6.1.3/junit-platform-${role}-6.1.3.jar`,
        )
      )
        throw Error("Pinned observer prerequisite");
    if (
      !pins.files.some(
        (file) =>
          file.path ===
          "org/junit/jupiter/junit-jupiter-engine/6.1.3/junit-jupiter-engine-6.1.3.jar",
      )
    )
      throw Error("Pinned engine prerequisite");
    return { distribution, repository, pins, manifestText };
  } catch {
    throw new GradlePrerequisiteError(
      "Gradle distribution and dependency artifacts must be bounded regular pinned files without links",
    );
  }
}
export const gradleModulePath = (value: string) =>
  value === "." ? ":" : ":" + value.split("/").join(":");
export async function gradleCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const prefix = project.path === "." ? "" : project.path + "/",
    inputs = source.files
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
  const check: Check = {
    id: "jvm.gradle-test",
    adapter: project.adapter,
    project: project.path,
    scope: inputs.filter((file) => file.endsWith(".java")),
    kind: "test",
    parser: "gradle-json",
    commands: [],
    reason:
      "Run a pinned offline Gradle build from fresh inputs and reconcile configured native tasks, JUnit execution and fresh XML reports.",
  };
  try {
    if (
      !project.files.includes("checktrail.gradle.json") ||
      !project.files.some((file) =>
        ["build.gradle", "build.gradle.kts"].includes(file),
      )
    )
      throw new GradlePrerequisiteError(
        "Prepare an inventoried checktrail.gradle.json for this Gradle build",
      );
    const config = gradleConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.gradle.json"),
        ),
      ),
    );
    if (
      new Set(config.modules.map((item) => item.path)).size !==
        config.modules.length ||
      !config.modules.some((item) => item.path === ".")
    )
      throw new GradlePrerequisiteError(
        "Gradle modules must be unique and include the root",
      );
    if (
      inputs.some(
        (file) =>
          /(?:^|\/)(?:buildSrc|build-logic|\.gradle)\//.test(file) ||
          (/(?:^|\/)gradle\/(?:wrapper|gradle-daemon-jvm)/.test(file) &&
            !(
              config.extensions &&
              jvmWrapperSourceFiles("gradle").includes(file)
            )),
      )
    )
      throw new GradlePrerequisiteError(
        "Gradle wrappers, build-logic and local cache inputs require a separate verified profile",
      );
    if (
      inputs.some(
        (file) =>
          /\.(?:kt|scala|groovy)$/.test(file) ||
          (file.endsWith(".kts") &&
            !/(?:^|\/)(?:build|settings)\.gradle\.kts$/.test(file)),
      )
    )
      throw new GradlePrerequisiteError(
        "Mixed JVM source languages require a separate verified compiler profile",
      );
    const actual = inputs.filter((file) =>
        ["build.gradle", "build.gradle.kts"].includes(
          path.posix.basename(file),
        ),
      ),
      declared = config.modules.flatMap((module) =>
        [
          path.posix.join(module.path, "build.gradle"),
          path.posix.join(module.path, "build.gradle.kts"),
        ].filter((file) => inputs.includes(file)),
      );
    if (
      config.modules.some(
        (module) =>
          actual.filter(
            (file) =>
              path.posix.dirname(file) ===
              (module.path === "." ? "." : module.path),
          ).length !== 1,
      ) ||
      JSON.stringify([...declared].sort()) !== JSON.stringify(actual.sort())
    )
      throw new GradlePrerequisiteError(
        "Declare each inventoried Gradle module with exactly one build script",
      );
    const settings = inputs.filter((file) =>
      ["settings.gradle", "settings.gradle.kts"].includes(
        path.posix.basename(file),
      ),
    );
    if (
      settings.length !== 1 ||
      !["settings.gradle", "settings.gradle.kts"].includes(settings[0]!)
    )
      throw new GradlePrerequisiteError(
        "This profile requires one root settings script and no composite builds",
      );
    if (config.extensions) {
      validateJvmExtensionScope(
        config.extensions,
        inputs,
        config.modules.map((m) => ({
          path: m.path,
          executable: m.kind === "java",
        })),
      );
      await verifyJvmWrapper(
        source.root,
        project.path,
        "gradle",
        config.extensions,
      );
      await verifyJvmToolchain();
    }
    const assigned = jvmGeneratorSourceFiles(config.extensions);
    for (const module of config.modules) {
      const testPrefix = path.posix.join(module.path, "src/test/java") + "/",
        tests = check.scope.filter((file) => file.startsWith(testPrefix)),
        roles = [
          ...module.testClasses.map((item) => item.file),
          ...module.supportTests,
        ].map((file) => path.posix.join(module.path, file));
      if (
        module.kind === "aggregator" &&
        (module.testClasses.length ||
          module.supportTests.length ||
          check.scope.some((file) =>
            file.startsWith(path.posix.join(module.path, "src") + "/"),
          ))
      )
        throw new GradlePrerequisiteError(
          "Aggregator modules cannot hide Java inputs or declare tests",
        );
      if (module.kind === "java" && !module.testClasses.length)
        throw new GradlePrerequisiteError(
          "Every Java module requires declared test classes",
        );
      if (
        new Set(roles).size !== roles.length ||
        roles.some((file) => !file.endsWith(".java")) ||
        JSON.stringify(roles.sort()) !== JSON.stringify(tests.sort()) ||
        new Set(module.testClasses.map((item) => item.className)).size !==
          module.testClasses.length
      )
        throw new GradlePrerequisiteError(
          "Declare every test source exactly once as a test class or support source",
        );
      for (const file of check.scope)
        if (
          file.startsWith(
            path.posix.join(module.path, "src/main/java") + "/",
          ) ||
          tests.includes(file)
        )
          assigned.add(file);
    }
    if (
      check.scope.some(
        (file) =>
          !assigned.has(file) ||
          (path.posix.basename(file) === "module-info.java" &&
            !config.extensions),
      )
    )
      throw new GradlePrerequisiteError(
        "Nonstandard, generated and JPMS source scopes require a separate verified profile",
      );
    await gradleTools(source.root, project.path, config);
    const pins = [];
    for (const file of inputs) {
      const bytes = await readFile(
        await mavenLocal(source.root, project.path, file),
      );
      if (bytes.length > 4 * 1024 * 1024)
        throw new GradlePrerequisiteError(
          "Gradle input exceeds the 4 MiB bound",
        );
      pins.push({ path: file, sha256: mavenHash(bytes) });
    }
    const invocation = JSON.stringify(
      gradleInvocationSchema.parse({ config, inputs: pins }),
    );
    if (Buffer.byteLength(invocation) > 100 * 1024)
      throw new GradlePrerequisiteError(
        "Gradle invocation exceeds its 100 KiB bound",
      );
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./gradle-runner.js", import.meta.url)),
        source.root,
        invocation,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: Object.fromEntries(
        gradleProtectedEnvironment
          .map((name) => [name, ""])
          .concat([["PATH", process.env.PATH ?? ""]]),
      ),
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof GradlePrerequisiteError
        ? error.message
        : "Gradle prerequisites are unavailable, unsupported or invalid";
  }
  return check;
}
