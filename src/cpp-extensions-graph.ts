import path from "node:path";
import { z } from "zod";
import { cppRequire, cppSame } from "./cpp-tools.js";
import { cppWords } from "./cpp-native.js";
import {
  cppExtensionsCmake,
  type CppExtensionsConfig,
} from "./cpp-extensions-contract.js";
import {
  cppExtensionsArtifact,
  cppExtensionsCompileArgs,
  cppExtensionsFlags,
  cppExtensionsIncludePaths,
  cppExtensionsLinkClosure,
  cppExtensionsUnits,
} from "./cpp-extensions-native.js";
const text = z.string().min(1).max(32768),
  index = z.number().int().nonnegative();
const traceSchema = z.object({
  commands: z.array(text).max(256),
  files: z.array(text).max(256),
  nodes: z
    .array(
      z.object({
        command: index.optional(),
        file: index,
        line: z.number().int().positive().optional(),
        parent: index.optional(),
      }),
    )
    .max(4096),
});
const dependency = z.object({ id: text, backtrace: index });
const list = z.array(dependency).max(32);
const reference = z.object({
  name: text,
  id: text,
  jsonFile: text,
  directoryIndex: index,
  projectIndex: z.literal(0),
});
const api = ".cmake/api/v1/reply/";
const ordered = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function cppExtensionsGraph(
  config: CppExtensionsConfig,
  workspace: string,
  build: string,
  tools: { name: string; entry: string }[],
  artifact: (file: string) => string,
) {
  const used = new Set<string>();
  const read = (file: string) => {
    cppRequire(
      /^[A-Za-z0-9_.-]+\.json$/.test(file),
      "Invalid native graph artifact name",
    );
    used.add(api + file);
    return JSON.parse(artifact(api + file));
  };
  const native = z
    .object({
      cmake: z.object({
        version: z.object({
          major: z.literal(4),
          minor: z.literal(2),
          patch: z.literal(3),
        }),
        generator: z.object({
          name: z.literal("Unix Makefiles"),
          multiConfig: z.literal(false),
        }),
      }),
      objects: z
        .array(
          z.object({
            kind: text,
            version: z.object({ major: index, minor: index }),
            jsonFile: text,
          }),
        )
        .length(2),
    })
    .parse(JSON.parse(artifact("file-api-index")));
  cppRequire(
    cppSame(
      native.objects.map((o) => o.kind),
      ["codemodel", "cmakeFiles"],
    ),
    "Native graph object cohort differs",
  );
  const object = (kind: string, major: number, minor: number) => {
    const item = native.objects.find((o) => o.kind === kind)!;
    cppRequire(
      item.version.major === major && item.version.minor === minor,
      "Native graph object version differs",
    );
    return read(item.jsonFile);
  };
  const model = z
    .object({
      kind: z.literal("codemodel"),
      version: z.object({ major: z.literal(2), minor: z.literal(9) }),
      paths: z.object({
        source: z.literal(workspace),
        build: z.literal(build),
      }),
      configurations: z
        .array(
          z.object({
            name: z.literal("Debug"),
            abstractTargets: z.array(z.unknown()).length(0),
            projects: z
              .array(
                z.object({
                  name: z.literal(config.project),
                  directoryIndexes: z.array(index),
                  targetIndexes: z.array(index),
                }),
              )
              .length(1),
            directories: z
              .array(
                z.object({
                  source: text,
                  build: text,
                  projectIndex: z.literal(0),
                  jsonFile: text,
                  parentIndex: index.optional(),
                  childIndexes: z.array(index).optional(),
                  targetIndexes: z.array(index),
                }),
              )
              .min(1)
              .max(16),
            targets: z.array(reference).min(3).max(32),
          }),
        )
        .length(1),
    })
    .parse(object("codemodel", 2, 9));
  const { directories, targets: refs, projects } = model.configurations[0]!;
  cppRequire(
    cppSame(
      directories.map((d) => d.source),
      config.directories,
    ),
    "Native local directory cohort differs",
  );
  cppRequire(
    cppSame(
      refs.map((t) => t.name),
      config.targets.map((t) => t.name),
    ) && new Set(refs.map((t) => t.id)).size === refs.length,
    "Native target cohort differs",
  );
  cppRequire(
    cppSame(
      projects[0]!.directoryIndexes.map(String),
      directories.map((_, i) => String(i)),
    ) &&
      cppSame(
        projects[0]!.targetIndexes.map(String),
        refs.map((_, i) => String(i)),
      ),
    "Native project graph membership differs",
  );
  for (const [i, d] of directories.entries()) {
    cppRequire(
      d.build === d.source,
      "Native directory output ownership differs",
    );
    const parent =
      d.source === "."
        ? undefined
        : directories.findIndex(
            (p) => p.source === path.posix.dirname(d.source),
          );
    cppRequire(d.parentIndex === parent, "Native directory parent differs");
    cppRequire(
      cppSame(
        (d.childIndexes ?? []).map(String),
        directories.flatMap((p, j) =>
          p.source !== "." && path.posix.dirname(p.source) === d.source
            ? [String(j)]
            : [],
        ),
      ),
      "Native directory children differ",
    );
    cppRequire(
      cppSame(
        d.targetIndexes.map(String),
        refs.flatMap((t, j) => (t.directoryIndex === i ? [String(j)] : [])),
      ),
      "Native directory target membership differs",
    );
    z.strictObject({
      backtraceGraph: z.strictObject({
        commands: z.array(z.unknown()).length(0),
        files: z.array(z.unknown()).length(0),
        nodes: z.array(z.unknown()).length(0),
      }),
      codemodelVersion: z.strictObject({
        major: z.literal(2),
        minor: z.literal(9),
      }),
      installers: z.array(z.unknown()).length(0),
      paths: z.strictObject({
        source: z.literal(d.source),
        build: z.literal(d.source),
      }),
    }).parse(read(d.jsonFile));
  }
  const manifests = cppExtensionsCmake(config);
  const trace = (
    graph: z.infer<typeof traceSchema>,
    at: number,
    command: string,
    allowedFiles: string[],
  ) => {
    const node = graph.nodes[at];
    cppRequire(
      node && node.command !== undefined && node.line !== undefined,
      "Native physical trace missing",
    );
    const file = graph.files[node.file];
    cppRequire(
      file &&
        allowedFiles.includes(file) &&
        graph.commands[node.command] === command &&
        manifests[file]?.split("\n")[node.line - 1]?.startsWith(command + "("),
      "Native physical graph trace differs",
    );
    return manifests[file]!.split("\n")[node.line - 1]!;
  };
  const cmakeFiles = z
    .object({
      kind: z.literal("cmakeFiles"),
      version: z.object({ major: z.literal(1), minor: z.literal(1) }),
      paths: z.object({
        source: z.literal(workspace),
        build: z.literal(build),
      }),
      inputs: z
        .array(
          z.object({
            path: text,
            isExternal: z.boolean().optional(),
            isGenerated: z.boolean().optional(),
            isCMake: z.boolean().optional(),
          }),
        )
        .max(1024),
    })
    .parse(object("cmakeFiles", 1, 1));
  const local: string[] = [];
  for (const f of cmakeFiles.inputs) {
    if (f.isExternal)
      cppRequire(
        f.isCMake && f.path.startsWith("/usr/share/cmake/"),
        "Undeclared external CMake input",
      );
    else if (f.isGenerated)
      cppRequire(
        f.path.startsWith(build + "/CMakeFiles/4.2.3/"),
        "Unexpected generated CMake input",
      );
    else {
      cppRequire(!path.isAbsolute(f.path), "Undeclared absolute CMake input");
      local.push(f.path);
    }
  }
  cppRequire(
    cppSame(local, [
      ...Object.keys(manifests),
      ...config.generatedHeaders.map((g) => g.template),
    ]),
    "Native CMake input cohort differs",
  );
  const id = (name: string) => refs.find((t) => t.name === name)!.id;
  for (const declared of config.targets) {
    const ref = refs.find((t) => t.name === declared.name)!;
    cppRequire(
      directories[ref.directoryIndex]?.source === declared.directory,
      "Native target directory differs",
    );
    const t = z
      .object({
        name: z.literal(declared.name),
        id: z.literal(ref.id),
        type: z.literal(
          declared.type === "static"
            ? "STATIC_LIBRARY"
            : declared.type === "shared"
              ? "SHARED_LIBRARY"
              : "EXECUTABLE",
        ),
        paths: z.object({
          source: z.literal(declared.directory),
          build: z.literal(declared.directory),
        }),
        nameOnDisk: text,
        artifacts: z.array(z.object({ path: text })).length(1),
        backtrace: index,
        backtraceGraph: traceSchema,
        sources: z
          .array(
            z.object({
              path: text,
              compileGroupIndex: index,
              sourceGroupIndex: index,
              backtrace: index,
            }),
          )
          .min(1)
          .max(64),
        sourceGroups: z
          .array(
            z.object({
              name: z.literal("Source Files"),
              sourceIndexes: z.array(index),
            }),
          )
          .length(1),
        compileGroups: z
          .array(
            z.object({
              language: z.enum(["C", "CXX"]),
              languageStandard: z.object({
                standard: text,
                backtraces: z.array(index),
              }),
              sourceIndexes: z.array(index),
              compileCommandFragments: z.array(z.object({ fragment: text })),
              defines: z.array(z.object({ define: text })).optional(),
              includes: z
                .array(z.object({ path: text, backtrace: index }))
                .optional(),
            }),
          )
          .min(1)
          .max(2),
        dependencies: list.optional(),
        compileDependencies: list.optional(),
        interfaceCompileDependencies: list.optional(),
        linkLibraries: list.optional(),
        interfaceLinkLibraries: list.optional(),
        link: z
          .object({
            language: z.enum(["C", "CXX"]),
            commandFragments: z.array(
              z.object({
                fragment: text,
                role: z.enum(["flags", "libraries"]),
                backtrace: index.optional(),
              }),
            ),
          })
          .optional(),
        archive: z.strictObject({}).optional(),
      })
      .parse(read(ref.jsonFile));
    const ownManifest = path.posix.join(declared.directory, "CMakeLists.txt"),
      add = declared.type === "executable" ? "add_executable" : "add_library";
    cppRequire(
      trace(t.backtraceGraph, t.backtrace, add, [ownManifest]).startsWith(
        add + "(" + declared.name + " ",
      ),
      "Native target declaration address differs",
    );
    cppRequire(
      cppSame(
        t.sources.map((s) => s.path),
        declared.sources,
      ) &&
        cppSame(
          t.sourceGroups[0]!.sourceIndexes.map(String),
          t.sources.map((_, i) => String(i)),
        ),
      "Native source membership differs",
    );
    const seen: number[] = [];
    for (const [groupIndex, group] of t.compileGroups.entries()) {
      cppRequire(
        group.languageStandard.standard ===
          (group.language === "C" ? "17" : "20") &&
          group.languageStandard.backtraces.length === 1 &&
          group.languageStandard.backtraces[0] === t.backtrace,
        "Native language standard differs",
      );
      cppRequire(
        ordered(
          group.compileCommandFragments.map((f) => f.fragment),
          [
            [
              ...cppExtensionsFlags(group.language),
              "-g",
              group.language === "C" ? "-std=c17" : "-std=c++20",
              declared.type === "executable" ? "-fPIE" : "-fPIC",
            ].join(" "),
          ],
        ),
        "Native compiler flags differ",
      );
      cppRequire(
        ordered(
          (group.defines ?? []).map((d) => d.define),
          declared.type === "shared" ? [declared.name + "_EXPORTS"] : [],
        ),
        "Native compiler definitions differ",
      );
      cppRequire(
        ordered(
          (group.includes ?? []).map((i) => i.path),
          cppExtensionsIncludePaths(config, declared.name, workspace, build),
        ),
        "Native public/private transitive include scope differs",
      );
      for (const include of group.includes ?? []) {
        const node = t.backtraceGraph.nodes[include.backtrace];
        cppRequire(node?.command !== undefined, "Native include trace missing");
        const command = t.backtraceGraph.commands[node.command];
        cppRequire(
          command === "target_include_directories" ||
            command === "target_link_libraries",
          "Native include trace kind differs",
        );
        trace(
          t.backtraceGraph,
          include.backtrace,
          command,
          Object.keys(manifests),
        );
      }
      for (const i of group.sourceIndexes) {
        const source = t.sources[i];
        cppRequire(
          source &&
            source.compileGroupIndex === groupIndex &&
            source.sourceGroupIndex === 0 &&
            source.path.endsWith(group.language === "C" ? ".c" : ".cpp") &&
            source.backtrace === t.backtrace,
          "Native translation unit group differs",
        );
        seen.push(i);
      }
    }
    cppRequire(
      cppSame(
        seen.map(String),
        t.sources.map((_, i) => String(i)),
      ),
      "Native compile groups omit or repeat a source",
    );
    const direct = [...declared.publicLinks, ...declared.privateLinks];
    for (const [observed, expected] of [
      [t.dependencies ?? [], cppExtensionsLinkClosure(config, declared.name)],
      [t.compileDependencies ?? [], direct],
      [t.linkLibraries ?? [], direct],
      [t.interfaceCompileDependencies ?? [], declared.publicLinks],
      [
        t.interfaceLinkLibraries ?? [],
        [
          ...declared.publicLinks,
          ...(declared.type === "static" ? declared.privateLinks : []),
        ],
      ],
    ] as const) {
      cppRequire(
        cppSame(
          observed.map((d) => d.id),
          expected.map(id),
        ),
        "Native transitive/direct interface link cohort differs",
      );
      for (const d of observed)
        trace(t.backtraceGraph, d.backtrace, "target_link_libraries", [
          ownManifest,
        ]);
    }
    const binary = cppExtensionsArtifact(config, declared.name);
    cppRequire(
      t.artifacts[0]!.path === binary &&
        t.nameOnDisk === path.posix.basename(binary),
      "Native target binary ownership differs",
    );
    if (declared.type === "static")
      cppRequire(t.archive && !t.link, "Native archive role differs");
    else {
      cppRequire(t.link && !t.archive, "Native linker role differs");
      const linked = cppExtensionsLinkClosure(config, declared.name);
      const libraries = t.link.commandFragments.filter(
        (f) => f.backtrace !== undefined,
      );
      cppRequire(
        ordered(
          libraries.map((f) => f.fragment),
          linked.map((name) =>
            path.posix.relative(
              declared.directory,
              cppExtensionsArtifact(config, name),
            ),
          ),
        ),
        "Native physical link artifact cohort differs",
      );
      for (const fragment of libraries) {
        cppRequire(
          fragment.role === "libraries",
          "Native link fragment role differs",
        );
        trace(
          t.backtraceGraph,
          fragment.backtrace!,
          "target_link_libraries",
          Object.keys(manifests),
        );
      }
      const rpaths = [
        ...new Set(
          linked
            .filter(
              (name) =>
                config.targets.find((t) => t.name === name)!.type === "shared",
            )
            .map((name) =>
              path.join(
                build,
                config.targets.find((t) => t.name === name)!.directory,
              ),
            ),
        ),
      ];
      const extra = t.link.commandFragments.filter(
        (f) => f.backtrace === undefined,
      );
      cppRequire(
        ordered(
          extra.map((f) => [f.role, f.fragment]),
          [
            [
              "flags",
              declared.type === "shared"
                ? "-shared"
                : [...cppExtensionsFlags(t.link.language), "-g"].join(" "),
            ],
            ["flags", "-Wl,--trace"],
            ...(rpaths.length
              ? [["libraries", "-Wl,-rpath," + rpaths.join(":")]]
              : []),
          ],
        ),
        "Native linker flags or runtime search paths differ",
      );
    }
  }
  const database = z
    .array(
      z.strictObject({
        directory: text,
        file: text,
        command: text,
        output: text,
      }),
    )
    .max(2048)
    .parse(JSON.parse(artifact("compile_commands.json")));
  const units = cppExtensionsUnits(config);
  cppRequire(
    database.length === units.length,
    "Native compile database denominator differs",
  );
  for (const unit of units) {
    const rows = database.filter(
      (r) => r.file === path.join(workspace, unit.file),
    );
    const compiler = tools.find(
      (t) => t.name === (unit.language === "C" ? "clang" : "clang++"),
    );
    cppRequire(
      compiler &&
        rows.length === 1 &&
        rows[0]!.directory === path.join(build, unit.directory) &&
        rows[0]!.output === unit.object &&
        ordered(cppWords(rows[0]!.command), [
          compiler.entry,
          ...cppExtensionsCompileArgs(config, workspace, build, unit),
        ]),
      "Native physical translation unit command differs",
    );
  }
  return { refs, units, used };
}
export function cppExtensionsCTestScope(
  raw: string,
  config: CppExtensionsConfig,
  workspace: string,
  build: string,
) {
  const native = z
    .object({
      kind: z.literal("ctestInfo"),
      version: z.object({ major: z.literal(1), minor: z.literal(0) }),
      backtraceGraph: traceSchema,
      tests: z
        .array(
          z.object({
            name: text,
            command: z.array(text),
            backtrace: index,
            properties: z.array(z.object({ name: text, value: z.unknown() })),
          }),
        )
        .min(1)
        .max(64),
    })
    .parse(JSON.parse(raw));
  cppRequire(
    cppSame(
      native.tests.map((t) => t.name),
      config.tests.map((t) => t.name),
    ),
    "Native CTest registration denominator differs",
  );
  const manifests = cppExtensionsCmake(config);
  for (const test of native.tests) {
    const declared = config.tests.find((t) => t.name === test.name)!,
      target = config.targets.find((t) => t.name === declared.target)!;
    cppRequire(
      ordered(test.command, [
        path.join(build, cppExtensionsArtifact(config, target.name)),
      ]),
      "Native CTest executable differs",
    );
    cppRequire(
      cppSame(
        test.properties.map((p) => p.name),
        ["TIMEOUT", "WORKING_DIRECTORY"],
      ) &&
        test.properties.find((p) => p.name === "TIMEOUT")!.value === 10 &&
        test.properties.find((p) => p.name === "WORKING_DIRECTORY")!.value ===
          path.join(build, target.directory),
      "Native CTest properties differ",
    );
    const node = native.backtraceGraph.nodes[test.backtrace],
      file = path.posix.join(target.directory, "CMakeLists.txt");
    cppRequire(
      node &&
        node.line !== undefined &&
        node.command !== undefined &&
        native.backtraceGraph.commands[node.command] === "add_test" &&
        native.backtraceGraph.files[node.file] === path.join(workspace, file) &&
        manifests[file]!.split("\n")[node.line - 1] ===
          `add_test(NAME ${test.name} COMMAND ${target.name})`,
      "Native CTest per-directory physical registration differs",
    );
  }
  return native.tests.map((t) => t.name);
}
