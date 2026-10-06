import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal } from "./maven.js";
import type { Check, Inventory, Project } from "./types.js";
import { z } from "zod";
import { externalPathSchema } from "./external-schema.js";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const swiftToolsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  swiftVersion: z.literal("6.2.3"),
  toolsVersion: z.literal("6.2.0"),
  platform: z.literal("aarch64-unknown-linux-gnu"),
  packageName: name,
  products: z
    .array(
      z.strictObject({
        name,
        type: z.enum(["library", "executable"]),
        targets: z.array(name).min(1).max(32),
      }),
    )
    .min(1)
    .max(32),
  targets: z
    .array(
      z.strictObject({
        name,
        type: z.enum(["regular", "executable", "test"]),
        path: externalPathSchema,
        sources: z.array(externalPathSchema).min(1).max(256),
        dependencies: z.array(name).max(32),
      }),
    )
    .min(1)
    .max(64),
  tests: z.strictObject({
    framework: z.enum(["xctest", "swift-testing"]),
    files: z.array(externalPathSchema).max(256),
    support: z.array(externalPathSchema).max(256),
  }),
  swiftlintVersion: z.literal("0.65.1"),
  rules: z
    .array(z.enum(["force_try", "force_unwrapping"]))
    .min(1)
    .max(2),
});
export type SwiftToolsConfig = z.infer<typeof swiftToolsConfigSchema>;
const same = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export class SwiftToolsPrerequisiteError extends Error {}
const requireData = (value: unknown, message: string): void => {
  if (!value) throw new SwiftToolsPrerequisiteError(message);
};

/** Validate declared scope without evaluating Package.swift or invoking SwiftPM. */
export function swiftToolsScope(config: SwiftToolsConfig, files: string[]) {
  const targets = new Map(
    config.targets.map((target) => [target.name, target]),
  );
  requireData(
    targets.size === config.targets.length,
    "Swift target names are ambiguous",
  );
  requireData(
    new Set(config.products.map((p) => p.name)).size === config.products.length,
    "Swift product names are ambiguous",
  );
  requireData(
    new Set(config.rules).size === config.rules.length,
    "Swift lint rules are duplicated",
  );
  const sources = config.targets.flatMap((target) => target.sources);
  requireData(
    same(
      sources,
      files.filter(
        (file) => file.endsWith(".swift") && file !== "Package.swift",
      ),
    ),
    "Declare every inventoried Swift source exactly once",
  );
  requireData(
    files.includes("Package.swift"),
    "Swift native scope needs an inventoried manifest",
  );
  for (const target of config.targets) {
    requireData(
      target.sources.every(
        (file) => file.startsWith(target.path + "/") && file.endsWith(".swift"),
      ),
      "Swift target sources must belong to their declared path",
    );
    requireData(
      target.sources.every((file) => path.posix.normalize(file) === file),
      "Swift source paths are not canonical",
    );
    requireData(
      new Set(target.dependencies).size === target.dependencies.length &&
        target.dependencies.every(
          (name) => targets.has(name) && name !== target.name,
        ),
      "Swift target dependencies are incomplete or duplicated",
    );
  }
  for (const product of config.products) {
    requireData(
      new Set(product.targets).size === product.targets.length &&
        product.targets.every(
          (name) => targets.has(name) && targets.get(name)!.type !== "test",
        ),
      "Swift product targets are incomplete or duplicated",
    );
    requireData(
      product.type !== "executable" ||
        product.targets.some(
          (name) => targets.get(name)!.type === "executable",
        ),
      "Swift executable product has no executable target",
    );
  }
  const active = new Set<string>(),
    visited = new Set<string>();
  const visit = (name: string) => {
    requireData(!active.has(name), "Swift target dependency cycle");
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of targets.get(name)!.dependencies) visit(dependency);
    active.delete(name);
    visited.add(name);
  };
  for (const target of targets.keys()) visit(target);
  const testSources = config.targets
    .filter((target) => target.type === "test")
    .flatMap((target) => target.sources);
  requireData(
    same([...config.tests.files, ...config.tests.support], testSources),
    "Swift test and support scope must cover every declared test target source exactly once",
  );
  requireData(
    config.tests.files.length > 0 || config.tests.support.length === 0,
    "Swift test support has no declared test file",
  );
  return { sources, testSources, targets };
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const swiftToolsInvocationSchema = z.strictObject({
  config: swiftToolsConfigSchema,
  inputs: z
    .array(z.strictObject({ path: externalPathSchema, sha256: digest }))
    .min(1)
    .max(2048),
});
export async function swiftToolsInputs(source: Inventory, project: Project) {
  requireData(
    project.files.includes("checktrail.swift-tools.json"),
    "Declare inventoried checktrail.swift-tools.json with complete Swift target scope",
  );
  const config = swiftToolsConfigSchema.parse(
    JSON.parse(
      await readProjectFile(
        source.root,
        path.posix.join(project.path, "checktrail.swift-tools.json"),
      ),
    ),
  );
  const prefix = project.path === "." ? "" : project.path + "/";
  const files = source.files
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
  swiftToolsScope(config, files);
  requireData(files.length <= 2048, "Swift input inventory exceeds its bound");
  const pins = [];
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(
      await mavenLocal(source.root, project.path, file),
    );
    bytes += content.length;
    requireData(
      content.length <= 4 * 1024 * 1024 && bytes <= 16 * 1024 * 1024,
      "Swift source inputs exceed their bound",
    );
    pins.push({ path: file, sha256: mavenHash(content) });
  }
  const invocation = swiftToolsInvocationSchema.parse({ config, inputs: pins });
  requireData(
    Buffer.byteLength(JSON.stringify(invocation)) <= 200 * 1024,
    "Swift invocation exceeds its bound",
  );
  return invocation;
}

export const swiftToolsProtectedEnvironment = [
  "SDKROOT",
  "DEVELOPER_DIR",
  "TOOLCHAINS",
  "SWIFT_EXEC",
  "SWIFT_DRIVER_SWIFT_FRONTEND_EXEC",
  "SWIFT_DRIVER_SWIFT_AUTOLINK_EXTRACT_EXEC",
  "SWIFTPM_BUILD_DIR",
  "SWIFTPM_TEST_RUNNER",
  "SWIFT_TEST_FILTER",
  "SWIFT_TEST_SKIP",
  "SWIFT_TESTING_DISABLE",
  "SWIFTLINT_CONFIG",
  "SCRIPT_INPUT_FILE_COUNT",
  "CC",
  "CXX",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "BASH_ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
];
export async function swiftToolsCheck(
  source: Inventory,
  project: Project,
  mode: "build" | "test" | "swiftlint",
): Promise<Check> {
  const check: Check = {
    id: `swift.${mode}`,
    adapter: "swift",
    project: project.path,
    scope: [],
    kind: mode === "test" ? "test" : "analysis",
    parser: "swift-tools-json",
    commands: [],
    reason:
      "Reconcile pinned SwiftPM scope with fresh native compiler, test or lint participation.",
  };
  try {
    const invocation = await swiftToolsInputs(source, project),
      config = invocation.config;
    check.scope =
      mode === "test"
        ? [...config.tests.files, ...config.tests.support]
        : config.targets.flatMap((t) => t.sources);
    requireData(
      check.scope.length > 0,
      "No Swift scope declared for this check",
    );
    check.commands.push({
      executable: process.execPath,
      cwd: project.path,
      temporaryDirectory: true,
      args: [
        fileURLToPath(new URL("./swift-tools-runner.js", import.meta.url)),
        source.root,
        JSON.stringify(invocation),
        mode,
      ],
      env: Object.fromEntries(
        swiftToolsProtectedEnvironment.map((k) => [k, ""]),
      ),
    });
  } catch (error) {
    check.unavailableReason =
      error instanceof SwiftToolsPrerequisiteError
        ? error.message
        : "Swift native prerequisites are invalid or unsupported";
  }
  return check;
}
