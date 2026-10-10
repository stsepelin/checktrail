import path from "node:path";
import { z } from "zod";
import { externalPathSchema, externalDigestSchema } from "./external-schema.js";
import { cppRequire, cppSame } from "./cpp-tools.js";
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const file = externalPathSchema
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/);
const sdkFile = externalPathSchema
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*$/);
const directory = z.union([z.literal("."), file]);
const target = z.strictObject({
  name,
  directory,
  type: z.enum(["static", "shared", "executable"]),
  sources: z.array(file).min(1).max(64),
  publicIncludes: z.array(file).max(16),
  privateIncludes: z.array(file).max(16),
  publicLinks: z.array(name).max(16),
  privateLinks: z.array(name).max(16),
});
export const cppExtensionsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("declared-local-cmake-transitive-sdk-v1"),
  project: name,
  clangVersion: z.literal("22.1.3"),
  cmakeVersion: z.literal("4.2.3"),
  makeVersion: z.literal("4.4.1"),
  binutilsVersion: z.literal("2.45.1"),
  platform: z.literal("aarch64-alpine-linux-musl"),
  sysroot: z.literal("/"),
  standardLibrary: z.literal("libstdc++"),
  directories: z.array(directory).min(1).max(16),
  headers: z.array(file).max(256),
  generatedHeaders: z
    .array(
      z.strictObject({
        directory,
        template: file,
        output: file,
        values: z.record(
          z.string().regex(/^CT_[A-Z0-9_]+$/),
          z.number().int().min(-2147483648).max(2147483647),
        ),
      }),
    )
    .min(1)
    .max(16),
  targets: z.array(target).min(3).max(32),
  tests: z
    .array(z.strictObject({ name, target: name }))
    .min(1)
    .max(64),
  tidyRules: z
    .array(
      z.enum(["bugprone-use-after-move", "clang-analyzer-core.DivideZero"]),
    )
    .min(1)
    .max(2),
  sdk: z
    .array(
      z.strictObject({
        path: sdkFile,
        resolved: sdkFile,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(128 * 1024 * 1024),
        sha256: externalDigestSchema,
      }),
    )
    .min(1)
    .max(8192),
});
export type CppExtensionsConfig = z.infer<typeof cppExtensionsConfigSchema>;
const unique = (values: string[], message: string) =>
  cppRequire(new Set(values).size === values.length, message);
const below = (file: string, dir: string) =>
  dir === "." || file.startsWith(dir + "/");
export const cppExtensionsSdkPath = (file: string) =>
  file.startsWith("usr/include/") ||
  file.startsWith("usr/lib/") ||
  ["lib/ld-musl-aarch64.so.1", "lib/libc.musl-aarch64.so.1"].includes(file);
/** Validate declared data only; no CMake evaluation or native process is allowed here. */
export function cppExtensionsScope(
  config: CppExtensionsConfig,
  files: string[],
) {
  unique(config.directories, "CMake directories repeated");
  cppRequire(
    config.directories[0] === "." && config.directories.length > 1,
    "CMake root and local subdirectory required",
  );
  for (const dir of config.directories.slice(1))
    cppRequire(
      config.directories.includes(path.posix.dirname(dir)),
      "CMake directory parent undeclared",
    );
  const manifests = config.directories.map((d) =>
    path.posix.join(d, "CMakeLists.txt"),
  );
  cppRequire(
    cppSame(
      manifests,
      files.filter((f) => path.posix.basename(f) === "CMakeLists.txt"),
    ),
    "Declare every local CMake manifest",
  );
  cppRequire(
    !files.some((f) =>
      /\.cmake$|\.(?:cc|cxx|C|c\+\+|hh|hxx|h\+\+|inc|ipp|tpp|ixx|cppm)$/.test(
        f,
      ),
    ),
    "Unsupported CMake/C++ source profile",
  );
  const targets = new Map(config.targets.map((t) => [t.name, t]));
  cppRequire(
    targets.size === config.targets.length,
    "CMake target names repeated",
  );
  for (const type of ["static", "shared", "executable"])
    cppRequire(
      config.targets.some((t) => t.type === type),
      "Each selected CMake target kind required",
    );
  cppRequire(
    cppSame(
      config.targets.flatMap((t) => t.sources),
      files.filter((f) => /\.(?:c|cpp)$/.test(f)),
    ),
    "Declare every C17/C++20 source exactly once",
  );
  cppRequire(
    cppSame(
      config.headers,
      files.filter((f) => /\.(?:h|hpp)$/.test(f)),
    ),
    "Declare every C/C++ header",
  );
  cppRequire(
    cppSame(
      config.generatedHeaders.map((g) => g.template),
      files.filter((f) => /\.h\.in$/.test(f)),
    ),
    "Declare every generated header template",
  );
  unique(
    config.generatedHeaders.map((g) => path.posix.join(g.directory, g.output)),
    "Generated output names repeated",
  );
  unique(
    config.generatedHeaders.flatMap((g) => Object.keys(g.values)),
    "Generated variable names repeated",
  );
  for (const g of config.generatedHeaders)
    cppRequire(
      config.directories.includes(g.directory) &&
        below(g.template, g.directory) &&
        /^generated\/[A-Za-z0-9_-]+\.h$/.test(g.output),
      "Generated header directory/output differs",
    );
  const includeDirectories = [
    ...config.headers.map((f) => path.posix.dirname(f)),
    ...config.generatedHeaders.map((g) =>
      path.posix.join(g.directory, path.posix.dirname(g.output)),
    ),
  ];
  for (const t of config.targets) {
    cppRequire(
      config.directories.includes(t.directory) &&
        t.sources.every((f) => below(f, t.directory)),
      "Target source/directory differs",
    );
    unique(
      [...t.publicIncludes, ...t.privateIncludes],
      "Target include scopes overlap",
    );
    cppRequire(
      [...t.publicIncludes, ...t.privateIncludes].every((d) =>
        includeDirectories.includes(d),
      ),
      "Target include directory undeclared",
    );
    unique([...t.publicLinks, ...t.privateLinks], "Target link scopes overlap");
    cppRequire(
      [...t.publicLinks, ...t.privateLinks].every(
        (n) =>
          targets.has(n) &&
          n !== t.name &&
          targets.get(n)!.type !== "executable",
      ),
      "Target link dependency invalid",
    );
    cppRequire(
      t.type !== "executable" ||
        (!t.publicLinks.length && !t.publicIncludes.length),
      "Executable cannot publish selected interfaces",
    );
  }
  for (const d of config.directories)
    cppRequire(
      config.targets.some((t) => t.directory === d),
      "Empty selected CMake directory",
    );
  const active = new Set<string>(),
    done = new Set<string>();
  const visit = (name: string) => {
    cppRequire(!active.has(name), "CMake link graph cycle");
    if (done.has(name)) return;
    active.add(name);
    const t = targets.get(name)!;
    for (const n of [...t.publicLinks, ...t.privateLinks]) visit(n);
    active.delete(name);
    done.add(name);
  };
  for (const t of config.targets.filter((t) => t.type === "executable"))
    visit(t.name);
  cppRequire(
    done.size === targets.size,
    "Declared library has no executable consumer",
  );
  unique(
    config.tests.map((t) => t.name),
    "CTest names repeated",
  );
  cppRequire(
    config.tests.every((t) => targets.get(t.target)?.type === "executable"),
    "CTest must name selected executable",
  );
  unique(config.tidyRules, "Analyzer rules repeated");
  unique(
    config.sdk.map((p) => p.path),
    "SDK pin paths repeated",
  );
  cppRequire(
    config.sdk.every(
      (p) =>
        [p.path, p.resolved].every(cppExtensionsSdkPath) &&
        config.sdk.some(
          (physical) =>
            physical.path === p.resolved &&
            physical.resolved === p.resolved &&
            physical.bytes === p.bytes &&
            physical.sha256 === p.sha256,
        ),
    ),
    "SDK pin outside selected sysroot include/library roots",
  );
  cppRequire(
    config.sdk.reduce((n, p) => n + p.bytes, 0) <= 512 * 1024 * 1024,
    "SDK total byte bound",
  );
}
/** Render the finite per-directory CMake contract; project commands remain data. */
export function cppExtensionsCmake(config: CppExtensionsConfig) {
  const result: Record<string, string> = {};
  for (const directory of config.directories) {
    const relative = (file: string) => path.posix.relative(directory, file);
    const lines =
      directory === "."
        ? [
            "cmake_minimum_required(VERSION 4.2)",
            `project(${config.project} VERSION 1.0.0 LANGUAGES C CXX)`,
            "set(CMAKE_C_STANDARD 17)",
            "set(CMAKE_C_STANDARD_REQUIRED ON)",
            "set(CMAKE_C_EXTENSIONS OFF)",
            "set(CMAKE_CXX_STANDARD 20)",
            "set(CMAKE_CXX_STANDARD_REQUIRED ON)",
            "set(CMAKE_CXX_EXTENSIONS OFF)",
            "set(CMAKE_POSITION_INDEPENDENT_CODE ON)",
            "enable_testing()",
          ]
        : [];
    for (const g of config.generatedHeaders.filter(
      (g) => g.directory === directory,
    )) {
      for (const [key, value] of Object.entries(g.values))
        lines.push(`set(${key} ${value})`);
      lines.push(`configure_file(${relative(g.template)} ${g.output} @ONLY)`);
    }
    for (const t of config.targets.filter((t) => t.directory === directory)) {
      lines.push(
        t.type === "executable"
          ? `add_executable(${t.name} ${t.sources.map(relative).join(" ")})`
          : `add_library(${t.name} ${t.type.toUpperCase()} ${t.sources.map(relative).join(" ")})`,
      );
      for (const [kind, includes] of [
        ["PUBLIC", t.publicIncludes],
        ["PRIVATE", t.privateIncludes],
      ] as const)
        if (includes.length)
          lines.push(
            `target_include_directories(${t.name} ${kind} ${includes.map((d) => '"${PROJECT_' + (config.generatedHeaders.some((g) => path.posix.join(g.directory, path.posix.dirname(g.output)) === d) ? "BINARY" : "SOURCE") + "_DIR}/" + d + '"').join(" ")})`,
          );
      for (const [kind, links] of [
        ["PUBLIC", t.publicLinks],
        ["PRIVATE", t.privateLinks],
      ] as const)
        if (links.length)
          lines.push(
            `target_link_libraries(${t.name} ${kind} ${links.join(" ")})`,
          );
    }
    for (const child of config.directories.filter(
      (d) => d !== "." && path.posix.dirname(d) === directory,
    ))
      lines.push(`add_subdirectory(${relative(child)})`);
    for (const test of config.tests.filter(
      (t) =>
        config.targets.find((x) => x.name === t.target)!.directory ===
        directory,
    )) {
      lines.push(`add_test(NAME ${test.name} COMMAND ${test.target})`);
      lines.push(`set_tests_properties(${test.name} PROPERTIES TIMEOUT 10)`);
    }
    result[path.posix.join(directory, "CMakeLists.txt")] =
      lines.join("\n") + "\n";
  }
  return result;
}

/** Preserve include visibility across local public interfaces without evaluating CMake. */
export function cppExtensionsIncludes(
  config: CppExtensionsConfig,
  target: string,
) {
  const targets = new Map(config.targets.map((t) => [t.name, t]));
  cppRequire(targets.has(target), "Requested CMake target undeclared");
  const active = new Set<string>();
  const published = (name: string): string[] => {
    cppRequire(!active.has(name), "CMake interface graph cycle");
    active.add(name);
    const t = targets.get(name);
    cppRequire(t, "CMake interface target undeclared");
    const values = [...t.publicIncludes, ...t.publicLinks.flatMap(published)];
    active.delete(name);
    return values;
  };
  const t = targets.get(target)!;
  return [
    ...new Set([
      ...t.publicIncludes,
      ...t.privateIncludes,
      ...[...t.publicLinks, ...t.privateLinks].flatMap(published),
    ]),
  ];
}
