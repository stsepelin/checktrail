import path from "node:path";
import { z } from "zod";
import type { SwiftExtensionsConfig } from "./swift-extensions-contract.js";
import { swiftRequire, swiftSame } from "./swift-native.js";
const text = z.string().max(8192),
  file = text.min(1),
  args = z.array(text).max(4096);
const moduleName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const identifier = z.union([
  z.strictObject({ swift: moduleName }),
  z.strictObject({ swiftPrebuiltExternal: moduleName }),
  z.strictObject({ clang: moduleName }),
]);
const dependencies = z.array(identifier).max(256);
const macros = z
  .array(
    z.strictObject({ moduleName, libraryPath: text, executablePath: text }),
  )
  .max(32);
const details = z.union([
  z.strictObject({
    swift: z.strictObject({
      commandLine: args,
      contextHash: file,
      userModuleVersion: text,
      macroDependencies: macros.optional(),
      isFramework: z.literal(false),
      sourceImportedDependencies: dependencies.optional(),
      moduleInterfacePath: file.optional(),
      compiledModuleCandidates: z.array(file).max(8).optional(),
    }),
  }),
  z.strictObject({
    swiftPrebuiltExternal: z.strictObject({
      compiledModulePath: file,
      userModuleVersion: text,
      macroDependencies: macros.optional(),
      isFramework: z.literal(false),
    }),
  }),
  z.strictObject({
    clang: z.strictObject({
      moduleMapPath: file,
      contextHash: file,
      commandLine: args,
    }),
  }),
]);
const record = z.strictObject({
  modulePath: file,
  sourceFiles: z.array(file).max(4096).optional(),
  directDependencies: dependencies,
  linkLibraries: z
    .array(
      z.strictObject({
        linkName: file,
        isStatic: z.boolean(),
        isFramework: z.literal(false),
        shouldForceLoad: z.boolean().optional(),
      }),
    )
    .max(64),
  imports: z
    .array(
      z.strictObject({
        identifier: moduleName,
        accessLevel: file,
        importLocations: z
          .array(
            z.strictObject({
              bufferIdentifier: file,
              linuNumber: z.number().int().positive(),
              columnNumber: z.number().int().positive(),
            }),
          )
          .max(64)
          .optional(),
      }),
    )
    .max(256),
  details,
});
const scanSchema = z.strictObject({
  mainModuleName: moduleName,
  modules: z
    .array(z.union([identifier, record]))
    .min(2)
    .max(512),
});
export const swiftExtensionsSdkRoots = {
  swift: "/usr/lib/swift",
  include: "/usr/include",
  clang: "/usr/lib/clang/17",
} as const;
export function swiftExtensionsSdkAddress(file: string) {
  swiftRequire(
    path.isAbsolute(file) &&
      path.normalize(file) === file &&
      !file.includes("\0"),
    "Swift SDK path is not canonical",
  );
  // The prepared runtime separately verifies this exact toolchain directory alias.
  const canonical = file.startsWith("/usr/lib/swift/clang/")
    ? "/usr/lib/clang/17/" + file.slice("/usr/lib/swift/clang/".length)
    : file;
  for (const [root, directory] of Object.entries(swiftExtensionsSdkRoots))
    if (canonical.startsWith(directory + "/"))
      return {
        root: root as keyof typeof swiftExtensionsSdkRoots,
        path: canonical.slice(directory.length + 1),
      };
  throw Error("Swift native SDK reference is outside the selected roots");
}
/** Bind actual compiler module/header references to a finite SDK byte policy. */
export function swiftExtensionsSdkReferences(
  config: SwiftExtensionsConfig,
  module: string,
  workspace: string,
  temporary: string,
  sources: string[],
  scanText: string,
  diagnostics: string,
) {
  swiftRequire(
    Buffer.byteLength(scanText) <= 4 * 1024 * 1024 && !scanText.includes("\0"),
    "Swift dependency scan exceeds its bound",
  );
  swiftRequire(
    Buffer.byteLength(diagnostics) <= 4 * 1024 * 1024 &&
      !diagnostics.includes("\0"),
    "Swift SDK diagnostics exceed their bound",
  );
  const expectedMappings = new Map([
      [
        "/usr/include/module.modulemap",
        "/usr/lib/swift/linux/aarch64/glibc.modulemap",
      ],
      [
        "/usr/include/SwiftGlibc.h",
        "/usr/lib/swift/linux/aarch64/SwiftGlibc.h",
      ],
    ]),
    mappings = new Map<string, string>();
  // Native -dump-clang-diagnostics reports the compiler's in-memory redirection.
  // This pins the actual SDK files even when an unrelated virtual address exists
  // physically. Swift 6.2.3: lib/ClangImporter/ClangIncludePaths.cpp.
  for (const line of diagnostics.split("\n")) {
    const match =
      /^ {3}mapping real file '([^'\r\n]+)' to virtual file '([^'\r\n]+)'$/.exec(
        line,
      );
    if (match) {
      const physical = match[1]!,
        virtual = match[2]!;
      swiftRequire(
        expectedMappings.get(virtual) === physical &&
          (!mappings.has(virtual) || mappings.get(virtual) === physical),
        "Swift native SDK redirection differs from the selected GNU profile",
      );
      mappings.set(virtual, physical);
    } else
      swiftRequire(
        !line.includes("mapping real file") &&
          !line.includes("overriding file"),
        "Swift SDK mapping diagnostics are malformed or unsupported",
      );
  }
  swiftRequire(
    mappings.size === expectedMappings.size,
    "Swift native SDK mapping cohort is incomplete",
  );
  const scan = scanSchema.parse(JSON.parse(scanText));
  swiftRequire(
    scan.mainModuleName === module && scan.modules.length % 2 === 0,
    "Swift dependency scan module identity differs",
  );
  const pins = new Map(config.sdk.map((p) => [p.root + "/" + p.path, p]));
  const modules = new Map<string, z.infer<typeof record>>(),
    references = new Map<
      string,
      { root: keyof typeof swiftExtensionsSdkRoots; path: string }
    >(),
    owned = new Set<string>(),
    macroBindings = new Set<string>();
  const identities = (v: z.infer<typeof identifier>) =>
    Object.entries(v)[0]!.join(":");
  const physical = (file: string) => {
    swiftRequire(
      path.isAbsolute(file) &&
        path.normalize(file) === file &&
        !file.includes("\0"),
      "Swift dependency path differs",
    );
    if (file.startsWith(temporary + path.sep)) {
      const ownedSources = sources.map((s) => path.join(workspace, s));
      const moduleCache =
        ["scratch", "cache", "home/.cache"].some((relative) =>
          file.startsWith(path.join(temporary, relative) + path.sep),
        ) && /\.(?:swiftmodule|pcm)$/.test(file);
      swiftRequire(
        ownedSources.includes(file) || moduleCache,
        "Swift native owned SDK dependency is outside its physical source/cache cohort",
      );
      owned.add(file);
      return;
    }
    const address = swiftExtensionsSdkAddress(mappings.get(file) ?? file),
      key = address.root + "/" + address.path;
    swiftRequire(
      pins.has(key),
      "Swift native SDK dependency has no physical byte pin",
    );
    references.set(key, address);
  };
  for (let i = 0; i < scan.modules.length; i += 2) {
    const id = identifier.parse(scan.modules[i]),
      row = record.parse(scan.modules[i + 1]),
      key = identities(id);
    swiftRequire(!modules.has(key), "Swift dependency module is repeated");
    modules.set(key, row);
    const kind = Object.keys(id)[0]!;
    swiftRequire(
      Object.hasOwn(row.details, kind),
      "Swift dependency kind/details differ",
    );
    const name = Object.values(id)[0]!;
    if (kind === "swift" && name === module) {
      swiftRequire(
        row.modulePath === module + ".swiftmodule" &&
          swiftSame(
            row.sourceFiles ?? [],
            sources.map((s) => path.join(workspace, s)),
          ) &&
          "swift" in row.details &&
          row.details.swift.moduleInterfacePath === undefined,
        "Swift scanned source cohort differs",
      );
    } else physical(row.modulePath);
    for (const file of row.sourceFiles ?? []) physical(file);
    if ("clang" in row.details) {
      swiftRequire(
        !!row.sourceFiles?.length,
        "Swift Clang header cohort is missing",
      );
      physical(row.details.clang.moduleMapPath);
    } else {
      const detail =
        "swift" in row.details
          ? row.details.swift
          : row.details.swiftPrebuiltExternal;
      for (const macro of detail.macroDependencies ?? []) {
        swiftRequire(
          !!macro.libraryPath !== !!macro.executablePath,
          "Swift macro executable identity is ambiguous",
        );
        physical(macro.libraryPath || macro.executablePath);
        macroBindings.add(
          JSON.stringify([
            macro.moduleName,
            macro.libraryPath,
            macro.executablePath,
          ]),
        );
      }
      if ("compiledModulePath" in detail) physical(detail.compiledModulePath);
      if ("moduleInterfacePath" in detail) {
        const address = swiftExtensionsSdkAddress(detail.moduleInterfacePath!);
        const directory = path.posix.dirname(address.path);
        const expectedCandidates = config.sdk
          .filter(
            (p) =>
              p.root === address.root &&
              path.posix.dirname(p.path) === directory &&
              p.path.endsWith(".swiftmodule"),
          )
          .map((p) => path.join(swiftExtensionsSdkRoots[p.root], p.path));
        swiftRequire(
          swiftSame(detail.compiledModuleCandidates ?? [], expectedCandidates),
          "Swift SDK module interface/candidates are incomplete",
        );
        physical(detail.moduleInterfacePath!);
        for (const candidate of detail.compiledModuleCandidates ?? [])
          physical(candidate);
      }
    }
  }
  swiftRequire(
    modules.has("swift:" + module),
    "Swift scan omits its main module",
  );
  for (const row of modules.values())
    for (const dependency of row.directDependencies)
      swiftRequire(
        modules.has(identities(dependency)),
        "Swift dependency graph has an omitted module",
      );
  for (const [name, macro] of [
    ["Swift", "SwiftMacros"],
    ["Foundation", "FoundationMacros"],
    ["Testing", "TestingMacros"],
  ]) {
    if (
      modules.has("swift:" + name) ||
      modules.has("swiftPrebuiltExternal:" + name)
    )
      swiftRequire(
        macroBindings.has(
          JSON.stringify([
            macro,
            "/usr/lib/swift/host/plugins/lib" + macro + ".so",
            "",
          ]),
        ),
        "Swift native SDK macro cohort is incomplete",
      );
  }
  const reached = new Set<string>();
  const visit = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const d of modules.get(name)!.directDependencies) visit(identities(d));
  };
  visit("swift:" + module);
  swiftRequire(
    reached.size === modules.size && references.size > 0,
    "Swift dependency scan contains an orphan module or no SDK references",
  );
  return {
    modules: [...modules.keys()].sort(),
    sdk: [...references.values()].sort((a, b) =>
      (a.root + "/" + a.path).localeCompare(b.root + "/" + b.path, "en"),
    ),
    owned: [...owned].sort(),
  };
}
