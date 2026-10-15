import path from "node:path";
import type { CppExtensionsConfig } from "./cpp-extensions-contract.js";
import { cppExtensionsIncludes } from "./cpp-extensions-contract.js";
import { cppRequire } from "./cpp-tools.js";
import { cppToolNames, cppSupportedVersion, cppDwarf } from "./cpp-native.js";
export const cppExtensionsToolNames = [
  ...cppToolNames,
  "llvm-readelf",
  "as",
  "ld",
] as const;
export const cppExtensionsFlags = (language: "C" | "CXX") => [
  "--no-default-config",
  "-B/usr/bin",
  "-fno-integrated-as",
  "--sysroot=/",
  "--target=aarch64-alpine-linux-musl",
  ...(language === "CXX" ? ["-stdlib=libstdc++"] : []),
  "-fno-implicit-modules",
  "-fno-implicit-module-maps",
  "-fdebug-macro",
  "-gdwarf-5",
  "-fdiagnostics-format=sarif",
  "-Wno-sarif-format-unstable",
];
export const cppExtensionsUnits = (config: CppExtensionsConfig) =>
  config.targets.flatMap((target) =>
    target.sources.map((file) => ({
      target: target.name,
      directory: target.directory,
      file,
      language: file.endsWith(".c") ? ("C" as const) : ("CXX" as const),
      object: path.posix.join(
        target.directory,
        `CMakeFiles/${target.name}.dir`,
        path.posix.relative(target.directory, file) + ".o",
      ),
    })),
  );
export function cppExtensionsArtifact(
  config: CppExtensionsConfig,
  name: string,
) {
  const target = config.targets.find((t) => t.name === name);
  cppRequire(target, "Native target artifact undeclared");
  return path.posix.join(
    target.directory,
    target.type === "executable"
      ? target.name
      : `lib${target.name}.${target.type === "static" ? "a" : "so"}`,
  );
}
export function cppExtensionsIncludePaths(
  config: CppExtensionsConfig,
  target: string,
  workspace: string,
  build: string,
) {
  const generated = config.generatedHeaders.map((g) =>
    path.posix.join(g.directory, path.posix.dirname(g.output)),
  );
  return cppExtensionsIncludes(config, target).map((d) =>
    path.join(generated.includes(d) ? build : workspace, d),
  );
}
export function cppExtensionsCompileArgs(
  config: CppExtensionsConfig,
  workspace: string,
  build: string,
  unit: ReturnType<typeof cppExtensionsUnits>[number],
) {
  const target = config.targets.find((t) => t.name === unit.target)!;
  return [
    ...(target.type === "shared" ? [`-D${target.name}_EXPORTS`] : []),
    ...cppExtensionsIncludePaths(config, target.name, workspace, build).map(
      (d) => "-I" + d,
    ),
    ...cppExtensionsFlags(unit.language),
    "-g",
    unit.language === "C" ? "-std=c17" : "-std=c++20",
    target.type === "executable" ? "-fPIE" : "-fPIC",
    "-o",
    path.posix.relative(target.directory, unit.object),
    "-c",
    path.join(workspace, unit.file),
  ];
}
export function cppExtensionsConfigure(
  workspace: string,
  build: string,
  tools: { name: string; entry: string }[],
) {
  const entry = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    cppRequire(tool, "Selected CMake tool missing");
    return tool.entry;
  };
  return [
    "-S",
    workspace,
    "-B",
    build,
    "-G",
    "Unix Makefiles",
    `-DCMAKE_MAKE_PROGRAM=${entry("make")}`,
    `-DCMAKE_C_COMPILER=${entry("clang")}`,
    `-DCMAKE_CXX_COMPILER=${entry("clang++")}`,
    `-DCMAKE_AR=${entry("llvm-ar")}`,
    `-DCMAKE_RANLIB=${entry("llvm-ranlib")}`,
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
    "-DCMAKE_BUILD_TYPE=Debug",
    `-DCMAKE_C_FLAGS=${cppExtensionsFlags("C").join(" ")}`,
    `-DCMAKE_CXX_FLAGS=${cppExtensionsFlags("CXX").join(" ")}`,
    "-DCMAKE_EXE_LINKER_FLAGS=-Wl,--trace",
    "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,--trace",
  ];
}
/** Static private links remain link-only requirements of downstream consumers. */
export function cppExtensionsLinkClosure(
  config: CppExtensionsConfig,
  name: string,
) {
  const found: string[] = [];
  const target = (name: string) => config.targets.find((t) => t.name === name)!;
  const visit = (name: string) => {
    if (found.includes(name)) return;
    found.push(name);
    const t = target(name);
    for (const dependency of [
      ...t.publicLinks,
      ...(t.type === "static" ? t.privateLinks : []),
    ])
      visit(dependency);
  };
  const t = target(name);
  for (const dependency of [...t.publicLinks, ...t.privateLinks])
    visit(dependency);
  return found;
}

export function cppExtensionsSupportedVersion(name: string, text: string) {
  if (name === "as")
    return (
      text.startsWith("GNU assembler (GNU Binutils) 2.45.1\n") &&
      text
        .trimEnd()
        .endsWith(
          "This assembler was configured for a target of `aarch64-alpine-linux-musl'.",
        )
    );
  if (name === "ld") return text.startsWith("GNU ld (GNU Binutils) 2.45.1\n");
  return cppSupportedVersion(name, text);
}

/** GNU as 2.45.1 emits the numeric .file MD5 operand in target byte order. */
export const cppExtensionsCrtDebugPins = [
  "usr/lib/Scrt1.o",
  "usr/lib/crti.o",
  "usr/lib/crtn.o",
] as const;
export function cppExtensionsDwarf(raw: string) {
  return new Map(
    [...cppDwarf(raw)].map(([file, digest]) => {
      cppRequire(
        digest === "" || /^[a-f0-9]{32}$/.test(digest),
        "Extension native line checksum missing",
      );
      return [file, Buffer.from(digest, "hex").reverse().toString("hex")];
    }),
  );
}

/** Exact GNU ld 2.45.1 CRT and library group order observed for this pinned driver. */
export function cppExtensionsLinkRuntime(
  language: "C" | "CXX",
  executable: boolean,
  trace = false,
) {
  const gcc = "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/",
    shared = "/usr/lib/libgcc_s.so";
  const group =
    language === "CXX"
      ? [
          shared,
          ...(trace ? [] : [shared, shared]),
          shared + ".1",
          gcc + "libgcc.a",
          gcc + "libgcc.a",
        ]
      : [
          gcc + "libgcc.a",
          shared,
          ...(trace ? [] : [shared, shared]),
          shared + ".1",
          gcc + "libgcc.a",
        ];
  return {
    prefix: [
      ...(executable ? ["/usr/lib/Scrt1.o"] : []),
      "/usr/lib/crti.o",
      gcc + "crtbeginS.o",
    ],
    suffix: [
      ...(language === "CXX"
        ? ["/usr/lib/libstdc++.so", "/usr/lib/libm.a"]
        : []),
      "/usr/lib/libssp_nonshared.a",
      ...group,
      "/usr/lib/libc.so",
      ...group,
      gcc + "crtendS.o",
      "/usr/lib/crtn.o",
    ],
  };
}
