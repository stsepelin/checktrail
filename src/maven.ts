import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { mavenDistributionFiles } from "./maven-distribution.js";
import type { Check, Inventory, Project } from "./types.js";

export const mavenHash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const modulePath = z.union([z.literal("."), externalPathSchema]);
export const mavenConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  distribution: externalPathSchema,
  repository: externalPathSchema,
  repositoryManifest: externalPathSchema,
  repositorySha256: digest,
  modules: z
    .array(
      z.strictObject({
        path: modulePath,
        packaging: z.enum(["pom", "jar"]),
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
export const mavenFileSchema = z.strictObject({
  path: externalPathSchema,
  bytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  sha256: digest,
});
export const mavenRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(mavenFileSchema).min(1).max(4096),
});
export const mavenInvocationSchema = z.strictObject({
  config: mavenConfigSchema,
  inputs: z
    .array(z.strictObject({ path: externalPathSchema, sha256: digest }))
    .min(1)
    .max(2048),
});
export class MavenPrerequisiteError extends Error {}
export async function mavenLocal(
  root: string,
  project: string,
  relative: string,
) {
  const requested = path.resolve(root, project, relative);
  const resolved = await withinRoot(root, path.relative(root, requested));
  if (requested !== resolved)
    throw new MavenPrerequisiteError(
      "Maven inputs cannot traverse symbolic links",
    );
  return resolved;
}
export async function verifyMavenTree(
  directory: string,
  files: z.infer<typeof mavenFileSchema>[],
) {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new MavenPrerequisiteError(
      "Maven artifact root must be a regular directory without links",
    );
  const expected = new Map(files.map((item) => [item.path, item]));
  if (expected.size !== files.length)
    throw new MavenPrerequisiteError("Duplicate Maven artifact paths");
  let total = 0,
    entries = 0;
  const walk = async (prefix: string) => {
    for (const item of await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    })) {
      if (++entries > 20000)
        throw new MavenPrerequisiteError(
          "Maven artifact inventory exceeds its bound",
        );
      const relative = path.posix.join(prefix, item.name),
        file = path.join(directory, relative);
      if (item.isSymbolicLink())
        throw new MavenPrerequisiteError(
          "Maven artifacts cannot contain links",
        );
      if (item.isDirectory()) {
        await walk(relative);
        continue;
      }
      const info = await lstat(file),
        pin = expected.get(relative);
      if (!info.isFile() || !pin || info.size !== pin.bytes)
        throw new MavenPrerequisiteError(
          "Maven artifact inventory does not match its manifest",
        );
      total += info.size;
      if (
        total > 256 * 1024 * 1024 ||
        mavenHash(await readFile(file)) !== pin.sha256
      )
        throw new MavenPrerequisiteError(
          "Maven artifact digest does not match",
        );
      expected.delete(relative);
    }
  };
  await walk("");
  if (expected.size)
    throw new MavenPrerequisiteError("Pinned Maven artifacts are missing");
}
export async function mavenTools(
  root: string,
  project: string,
  config: z.infer<typeof mavenConfigSchema>,
) {
  const distribution = await mavenLocal(root, project, config.distribution);
  const repository = await mavenLocal(root, project, config.repository);
  if (
    distribution === repository ||
    distribution.startsWith(repository + path.sep) ||
    repository.startsWith(distribution + path.sep)
  )
    throw new MavenPrerequisiteError("Maven artifact trees must be distinct");
  const manifest = await mavenLocal(root, project, config.repositoryManifest),
    info = await lstat(manifest);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new MavenPrerequisiteError(
      "Maven dependency manifest exceeds its bound",
    );
  const bytes = await readFile(manifest);
  if (mavenHash(bytes) !== config.repositorySha256)
    throw new MavenPrerequisiteError(
      "Maven dependency manifest digest does not match",
    );
  const pins = mavenRepositorySchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  await verifyMavenTree(distribution, mavenDistributionFiles);
  await verifyMavenTree(repository, pins.files);
  for (const name of ["launcher", "engine", "commons"]) {
    if (
      !pins.files.some(
        (item) =>
          item.path ===
          `org/junit/platform/junit-platform-${name}/6.1.3/junit-platform-${name}-6.1.3.jar`,
      )
    )
      throw new MavenPrerequisiteError(
        "Prepare the pinned JUnit Platform 6.1.3 observer dependencies",
      );
  }
  return { distribution, repository, pins };
}
export async function mavenCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const prefix = project.path === "." ? "" : `${project.path}/`;
  const inputs = source.files
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
  const check: Check = {
    id: "jvm.maven-test",
    adapter: project.adapter,
    project: project.path,
    scope: inputs.filter((file) => file.endsWith(".java")),
    kind: "test",
    parser: "maven-json",
    commands: [],
    reason:
      "Run a pinned offline Maven reactor in a fresh input copy, reconciling native plugin/test events and fresh test reports.",
  };
  try {
    if (
      !project.files.includes("checktrail.maven.json") ||
      !project.files.includes("pom.xml")
    )
      throw new MavenPrerequisiteError(
        "Prepare an inventoried checktrail.maven.json for this Maven reactor",
      );
    const config = mavenConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.maven.json"),
        ),
      ),
    );
    if (
      new Set(config.modules.map((item) => item.path)).size !==
        config.modules.length ||
      !config.modules.some((item) => item.path === ".")
    )
      throw new MavenPrerequisiteError(
        "Maven reactor modules must be unique and include the root",
      );
    if (inputs.some((file) => /(?:^|\/)\.mvn\//.test(file)))
      throw new MavenPrerequisiteError(
        "Maven project startup configuration requires a separate verified profile",
      );
    if (inputs.some((file) => /\.(?:kt|kts|scala)$/.test(file)))
      throw new MavenPrerequisiteError(
        "Mixed JVM languages require a separate verified compiler profile",
      );
    if (inputs.some((file) => /(?:^|\/)target\//.test(file)))
      throw new MavenPrerequisiteError(
        "Build outputs cannot be Maven reactor inputs",
      );
    const poms = config.modules.map((item) =>
      path.posix.join(item.path, "pom.xml"),
    );
    const actualPoms = inputs.filter(
      (file) => path.posix.basename(file) === "pom.xml",
    );
    if (JSON.stringify([...poms].sort()) !== JSON.stringify(actualPoms.sort()))
      throw new MavenPrerequisiteError(
        "Declare every inventoried Maven module",
      );
    const assigned = new Set<string>();
    for (const module of config.modules) {
      const tests = inputs.filter((file) =>
        file.startsWith(path.posix.join(module.path, "src/test/java") + "/"),
      );
      const declared = [
        ...module.testClasses.map((item) => item.file),
        ...module.supportTests,
      ].map((file) => path.posix.join(module.path, file));
      if (
        module.packaging === "pom" &&
        check.scope.some((file) =>
          file.startsWith(path.posix.join(module.path, "src") + "/"),
        )
      )
        throw new MavenPrerequisiteError(
          "Aggregator Java sources require an executable module profile",
        );
      if (
        module.packaging === "pom" &&
        (module.testClasses.length || module.supportTests.length)
      )
        throw new MavenPrerequisiteError(
          "Aggregator modules cannot declare test sources",
        );
      if (module.packaging === "jar" && !module.testClasses.length)
        throw new MavenPrerequisiteError(
          "Each selected executable module needs declared test classes",
        );
      if (
        declared.some((file) => !file.endsWith(".java")) ||
        new Set(declared).size !== declared.length ||
        JSON.stringify(declared.sort()) !==
          JSON.stringify(tests.filter((file) => file.endsWith(".java")).sort())
      )
        throw new MavenPrerequisiteError(
          "Declare each test source as a test class or support input",
        );
      if (
        new Set(module.testClasses.map((item) => item.className)).size !==
        module.testClasses.length
      )
        throw new MavenPrerequisiteError("Duplicate declared Maven test class");
      for (const file of check.scope) {
        if (
          file.startsWith(
            path.posix.join(module.path, "src/main/java") + "/",
          ) ||
          tests.includes(file)
        )
          assigned.add(file);
      }
    }
    if (
      check.scope.some(
        (file) =>
          !assigned.has(file) ||
          path.posix.basename(file) === "module-info.java",
      )
    )
      throw new MavenPrerequisiteError(
        "Nonstandard, generated and JPMS source scope needs a separate verified profile",
      );
    await mavenTools(source.root, project.path, config);
    const inputPins = [];
    for (const file of inputs) {
      const bytes = await readFile(
        await mavenLocal(source.root, project.path, file),
      );
      if (bytes.length > 4 * 1024 * 1024)
        throw new MavenPrerequisiteError(
          "Maven source input exceeds its 4 MiB bound",
        );
      inputPins.push({ path: file, sha256: mavenHash(bytes) });
    }
    const invocation = mavenInvocationSchema.parse({
      config,
      inputs: inputPins,
    });
    const serialized = JSON.stringify(invocation);
    if (Buffer.byteLength(serialized) > 100 * 1024)
      throw new MavenPrerequisiteError(
        "Maven invocation exceeds its 100 KiB bound",
      );
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./maven-runner.js", import.meta.url)),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: Object.fromEntries(
        [
          "JAVA_TOOL_OPTIONS",
          "JDK_JAVA_OPTIONS",
          "_JAVA_OPTIONS",
          "CLASSPATH",
          "MAVEN_OPTS",
          "MAVEN_ARGS",
          "MAVEN_EXT_CLASS_PATH",
          "MAVEN_CONFIG",
          "MAVEN_SKIP_RC",
          "MAVEN_HOME",
          "MAVEN_USER_HOME",
          "JAVA_HOME",
          "HOME",
          "ENV",
          "BASH_ENV",
        ]
          .map((name) => [name, ""])
          .concat([["PATH", process.env.PATH ?? ""]]),
      ),
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof MavenPrerequisiteError
        ? error.message
        : "Maven prerequisites are unavailable, unsupported or invalid";
  }
  return check;
}
