import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { mavenHash, mavenLocal } from "./maven.js";
import type { Check, Inventory, Project } from "./types.js";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const file = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/);
export const cppToolsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  project: name,
  clangVersion: z.literal("22.1.3"),
  cmakeVersion: z.literal("4.2.3"),
  makeVersion: z.literal("4.4.1"),
  platform: z.literal("aarch64-alpine-linux-musl"),
  includeDirectories: z.array(file).max(16),
  headers: z.array(file).max(256),
  generatedHeaders: z
    .array(
      z.strictObject({
        template: file,
        output: file,
        values: z.record(
          z.string().regex(/^CT_[A-Z0-9_]+$/),
          z.number().int().min(-2147483648).max(2147483647),
        ),
      }),
    )
    .max(16),
  targets: z
    .array(
      z.strictObject({
        name,
        type: z.enum(["static", "executable"]),
        sources: z.array(file).min(1).max(64),
        dependencies: z.array(name).max(16),
      }),
    )
    .min(1)
    .max(32),
  tests: z.array(z.strictObject({ name, target: name })).max(64),
  tidyRules: z
    .array(
      z.enum(["bugprone-use-after-move", "clang-analyzer-core.DivideZero"]),
    )
    .min(1)
    .max(2),
});
export type CppToolsConfig = z.infer<typeof cppToolsConfigSchema>;
export function cppRequire(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const cppSame = (a: string[], b: string[]) =>
  new Set(a).size === a.length &&
  new Set(b).size === b.length &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function cppScope(config: CppToolsConfig, files: string[]) {
  const targets = new Map(config.targets.map((t) => [t.name, t]));
  cppRequire(targets.size === config.targets.length, "Duplicate CMake targets");
  cppRequire(
    cppSame(config.tidyRules, [...new Set(config.tidyRules)]),
    "Duplicate analyzer rules",
  );
  const variables = config.generatedHeaders.flatMap((g) =>
    Object.keys(g.values),
  );
  cppRequire(
    new Set(variables).size === variables.length,
    "Generated variables overlap across headers",
  );
  const sources = config.targets.flatMap((t) => t.sources);
  cppRequire(
    cppSame(
      sources,
      files.filter((f) => /\.(?:c|cpp)$/.test(f)),
    ),
    "Declare every C17/C++20 translation unit exactly once",
  );
  cppRequire(
    cppSame(
      config.headers,
      files.filter((f) => /\.(?:h|hpp)$/.test(f)),
    ),
    "Declare every inventoried C/C++ header",
  );
  cppRequire(
    cppSame(
      config.generatedHeaders.map((g) => g.template),
      files.filter((f) => /\.h\.in$/.test(f)),
    ),
    "Declare every generated header template",
  );
  cppRequire(
    files.includes("CMakeLists.txt") &&
      files.filter((f) =>
        /(?:CMakeLists\.txt|\.cmake|\.(?:cc|cxx|C|c\+\+|hh|hxx|h\+\+|inc|ipp|tpp|ixx|cppm))$/.test(
          f,
        ),
      ).length === 1,
    "Unsupported CMake or C/C++ source profile",
  );
  cppRequire(
    new Set(config.generatedHeaders.map((g) => g.output)).size ===
      config.generatedHeaders.length &&
      config.generatedHeaders.every((g) =>
        /^generated\/[A-Za-z0-9_-]+\.h$/.test(g.output),
      ),
    "Generated headers require unique owned generated paths",
  );
  cppRequire(
    cppSame(config.includeDirectories, [
      ...new Set(config.includeDirectories),
    ]) &&
      config.includeDirectories.every((d) =>
        config.headers.some((f) => f.startsWith(d + "/")),
      ),
    "Include directories must own declared headers",
  );
  for (const target of config.targets) {
    cppRequire(
      target.sources.every((f) => /\.(?:c|cpp)$/.test(f)),
      "Unsupported translation unit",
    );
    cppRequire(
      cppSame(target.dependencies, [...new Set(target.dependencies)]) &&
        target.dependencies.every(
          (n) => targets.get(n)?.type === "static" && n !== target.name,
        ),
      "Unsupported target dependency",
    );
    cppRequire(
      target.type === "executable" || target.dependencies.length === 0,
      "This static-library profile has no transitive libraries",
    );
    cppRequire(
      new Set(target.sources.map((f) => path.posix.basename(f))).size ===
        target.sources.length,
      "Ambiguous archive member basename",
    );
  }
  cppRequire(
    new Set(config.tests.map((t) => t.name)).size === config.tests.length &&
      config.tests.every((t) => targets.get(t.target)?.type === "executable"),
    "CTest cases must name declared executable targets",
  );
  cppRequire(
    config.targets.every(
      (t) =>
        t.type !== "static" ||
        config.targets.some((other) => other.dependencies.includes(t.name)),
    ),
    "Static library has no linked consumer",
  );
}
/** A finite CMake language profile. Exact comparison prevents undeclared commands/configuration. */
export function cppCmake(config: CppToolsConfig) {
  const lines = [
    "cmake_minimum_required(VERSION 4.2)",
    `project(${config.project} VERSION 1.0.0 LANGUAGES C CXX)`,
    "set(CMAKE_C_STANDARD 17)",
    "set(CMAKE_C_STANDARD_REQUIRED ON)",
    "set(CMAKE_C_EXTENSIONS OFF)",
    "set(CMAKE_CXX_STANDARD 20)",
    "set(CMAKE_CXX_STANDARD_REQUIRED ON)",
    "set(CMAKE_CXX_EXTENSIONS OFF)",
  ];
  for (const g of config.generatedHeaders) {
    for (const [key, value] of Object.entries(g.values))
      lines.push(`set(${key} ${value})`);
    lines.push(`configure_file(${g.template} ${g.output} @ONLY)`);
  }
  const includes = [
    ...config.includeDirectories,
    ...(config.generatedHeaders.length
      ? ['"${CMAKE_CURRENT_BINARY_DIR}/generated"']
      : []),
  ];
  for (const t of config.targets) {
    lines.push(
      t.type === "static"
        ? `add_library(${t.name} STATIC ${t.sources.join(" ")})`
        : `add_executable(${t.name} ${t.sources.join(" ")})`,
    );
    if (includes.length)
      lines.push(
        `target_include_directories(${t.name} PRIVATE ${includes.join(" ")})`,
      );
    if (t.dependencies.length)
      lines.push(
        `target_link_libraries(${t.name} PRIVATE ${t.dependencies.join(" ")})`,
      );
  }
  lines.push("enable_testing()");
  for (const t of config.tests)
    lines.push(`add_test(NAME ${t.name} COMMAND ${t.target})`);
  if (config.tests.length)
    lines.push(
      `set_tests_properties(${config.tests.map((t) => t.name).join(" ")} PROPERTIES TIMEOUT 10)`,
    );
  return lines.join("\n") + "\n";
}
export const cppToolsInvocationSchema = z.strictObject({
  config: cppToolsConfigSchema,
  inputs: z
    .array(
      z.strictObject({
        path: file,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        md5: z.string().regex(/^[a-f0-9]{32}$/),
        text: z.string().max(1024 * 1024),
      }),
    )
    .min(1)
    .max(512),
});
export type CppToolsInvocation = z.infer<typeof cppToolsInvocationSchema>;
export const cppProtectedEnvironment = [
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "CCC_OVERRIDE_OPTIONS",
  "CLANG_CONFIG_FILE_USER_DIR",
  "CLANG_CONFIG_FILE_SYSTEM_DIR",
  "CMAKE_PREFIX_PATH",
  "CMAKE_TOOLCHAIN_FILE",
  "CMAKE_GENERATOR",
  "CMAKE_PROJECT_TOP_LEVEL_INCLUDES",
  "MAKEFLAGS",
  "MFLAGS",
  "CTEST_PARALLEL_LEVEL",
  "CTEST_TEST_TIMEOUT",
  "CTEST_OUTPUT_ON_FAILURE",
];
export async function cppToolsCheck(
  source: Inventory,
  project: Project,
  mode: "build" | "ctest" | "clang-format" | "clang-tidy",
): Promise<Check> {
  const check: Check = {
    id: `cpp.${mode}`,
    adapter: project.adapter,
    project: project.path,
    kind: mode === "ctest" ? "test" : "analysis",
    parser: "cpp-tools-json",
    commands: [],
    scope: [],
    reason:
      "Reconcile declared CMake scope with fresh native C17/C++20 compilation, formatting, analysis or registered CTest callbacks.",
  };
  try {
    const config = cppToolsConfigSchema.parse(
      JSON.parse(
        await readProjectFile(
          source.root,
          path.posix.join(project.path, "checktrail.cpp-tools.json"),
        ),
      ),
    );
    cppScope(config, project.files);
    const selected = [
      "CMakeLists.txt",
      "checktrail.cpp-tools.json",
      ...config.targets.flatMap((t) => t.sources),
      ...config.headers,
      ...config.generatedHeaders.map((g) => g.template),
    ].sort();
    const { createHash } = await import("node:crypto");
    const inputs = await Promise.all(
      selected.map(async (file) => {
        const bytes = await readFile(
          await mavenLocal(source.root, project.path, file),
        );
        const text = bytes.toString("utf8");
        cppRequire(
          Buffer.from(text).equals(bytes) && bytes.length <= 1024 * 1024,
          "Unsupported source encoding or size",
        );
        cppRequire(
          !/NOLINT|clang-format\s+(?:off|on)|#\s*pragma\s+clang\s+diagnostic|_Pragma/.test(
            text,
          ),
          "Source analyzer suppressions require another profile",
        );
        return {
          path: file,
          text,
          sha256: mavenHash(bytes),
          md5: createHash("md5").update(bytes).digest("hex"),
        };
      }),
    );
    cppRequire(
      inputs.find((i) => i.path === "CMakeLists.txt")!.text ===
        cppCmake(config),
      "CMakeLists.txt differs from the declared finite native profile",
    );
    const invocation = cppToolsInvocationSchema.parse({ config, inputs });
    cppRequire(
      Buffer.byteLength(JSON.stringify(invocation)) <= 100 * 1024,
      "C/C++ native invocation exceeds 100 KiB",
    );
    check.scope =
      mode === "ctest"
        ? config.targets
            .filter((t) => config.tests.some((c) => c.target === t.name))
            .flatMap((t) => t.sources)
        : [...config.targets.flatMap((t) => t.sources), ...config.headers];
    cppRequire(check.scope.length > 0, "No C/C++ scope declared");
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./cpp-tools-runner.js", import.meta.url)),
        source.root,
        JSON.stringify(invocation),
        mode,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(cppProtectedEnvironment.map((k) => [k, ""])),
        PATH: process.env.PATH ?? "",
        CCC_OVERRIDE_OPTIONS: "#",
      },
    });
  } catch {
    check.unavailableReason =
      "C/C++ tools require a complete supported checktrail.cpp-tools.json and its exact declared CMakeLists.txt";
  }
  return check;
}
