import path from "node:path";
import { z } from "zod";
import {
  cppRequire,
  cppSame,
  cppCmake,
  type CppToolsConfig,
} from "./cpp-tools.js";
import { cppCompileArgs, cppFlags, cppUnits, cppWords } from "./cpp-native.js";
const string = z.string(),
  strings = z.array(string),
  index = z.number().int().nonnegative();
const reference = z.object({ name: string, id: string, jsonFile: string });
export function cppCmakeEvidence(
  c: CppToolsConfig,
  workspace: string,
  build: string,
  tools: { name: string; entry: string }[],
  artifact: (file: string) => string,
) {
  const api = ".cmake/api/v1/reply/";
  const entry = (name: string) => tools.find((t) => t.name === name)!.entry;
  const metadata = z.object({
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
    objects: z.array(
      z.object({
        kind: string,
        version: z.object({ major: index, minor: index }),
        jsonFile: string,
      }),
    ),
  });
  const files = JSON.parse(artifact("file-api-index"));
  const native = metadata.parse(files);
  cppRequire(
    cppSame(
      native.objects.map((o) => o.kind),
      ["codemodel", "cmakeFiles"],
    ),
    "Unexpected file API objects",
  );
  const object = (kind: string, major: number, minor: number) => {
    const item = native.objects.find((o) => o.kind === kind)!;
    cppRequire(
      item.version.major === major &&
        item.version.minor === minor &&
        /^[A-Za-z0-9_.-]+\.json$/.test(item.jsonFile),
      "Unexpected file API version/path",
    );
    return JSON.parse(artifact(api + item.jsonFile));
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
                  name: z.literal(c.project),
                  directoryIndexes: z.array(index),
                  targetIndexes: z.array(index),
                }),
              )
              .length(1),
            directories: z
              .array(
                z.object({
                  source: z.literal("."),
                  build: z.literal("."),
                  projectIndex: z.literal(0),
                  jsonFile: string,
                  targetIndexes: z.array(index),
                }),
              )
              .length(1),
            targets: z.array(reference),
          }),
        )
        .length(1),
    })
    .parse(object("codemodel", 2, 9));
  const directory = model.configurations[0]!.directories[0]!;
  cppRequire(
    /^[A-Za-z0-9_.-]+\.json$/.test(directory.jsonFile),
    "Invalid native directory metadata path",
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
    paths: z.strictObject({ source: z.literal("."), build: z.literal(".") }),
  }).parse(JSON.parse(artifact(api + directory.jsonFile)));
  const refs = model.configurations[0]!.targets;
  cppRequire(
    cppSame(
      refs.map((t) => t.name),
      c.targets.map((t) => t.name),
    ) && new Set(refs.map((t) => t.id)).size === refs.length,
    "Native target scope differs",
  );
  const cmakeFiles = z
    .object({
      kind: z.literal("cmakeFiles"),
      version: z.object({ major: z.literal(1), minor: z.literal(1) }),
      paths: z.object({
        source: z.literal(workspace),
        build: z.literal(build),
      }),
      inputs: z.array(
        z.object({
          path: string,
          isExternal: z.boolean().optional(),
          isGenerated: z.boolean().optional(),
          isCMake: z.boolean().optional(),
        }),
      ),
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
      cppRequire(!path.isAbsolute(f.path), "Unexpected absolute CMake input");
      local.push(f.path);
    }
  }
  cppRequire(
    cppSame(local, [
      "CMakeLists.txt",
      ...c.generatedHeaders.map((g) => g.template),
    ]),
    "CMake input scope differs",
  );
  const used = new Set<string>();
  for (const target of c.targets) {
    const ref = refs.find((t) => t.name === target.name)!;
    cppRequire(
      /^[A-Za-z0-9_.-]+\.json$/.test(ref.jsonFile),
      "Invalid target file API path",
    );
    const t = z
      .object({
        name: z.literal(target.name),
        id: z.literal(ref.id),
        type: z.literal(
          target.type === "static" ? "STATIC_LIBRARY" : "EXECUTABLE",
        ),
        paths: z.object({ source: z.literal("."), build: z.literal(".") }),
        sources: z.array(z.object({ path: string, compileGroupIndex: index })),
        compileGroups: z.array(
          z.object({
            language: z.enum(["C", "CXX"]),
            languageStandard: z.object({ standard: string }),
            sourceIndexes: z.array(index),
            compileCommandFragments: z.array(z.object({ fragment: string })),
            includes: z.array(z.object({ path: string })).optional(),
          }),
        ),
        dependencies: z.array(z.object({ id: string })).optional(),
        linkLibraries: z.array(z.object({ id: string })).optional(),
        artifacts: z.array(z.object({ path: string })).length(1),
      })
      .parse(JSON.parse(artifact(api + ref.jsonFile)));
    cppRequire(
      cppSame(
        t.sources.map((s) => s.path),
        target.sources,
      ),
      "Native target sources differ",
    );
    const observedIndexes: number[] = [];
    for (const group of t.compileGroups) {
      cppRequire(
        group.languageStandard.standard ===
          (group.language === "C" ? "17" : "20"),
        "Native language standard differs",
      );
      cppRequire(
        cppSame(
          (group.includes ?? []).map((i) => i.path),
          [
            ...c.includeDirectories.map((d) => path.join(workspace, d)),
            ...(c.generatedHeaders.length
              ? [path.join(build, "generated")]
              : []),
          ],
        ),
        "Native compiler include scope differs",
      );
      cppRequire(
        group.compileCommandFragments.map((f) => f.fragment).join(" ") ===
          [
            ...cppFlags,
            "-g",
            group.language === "C" ? "-std=c17" : "-std=c++20",
          ].join(" "),
        "Native compiler flags differ",
      );
      for (const i of group.sourceIndexes) {
        const source = t.sources[i];
        cppRequire(
          source &&
            t.compileGroups[source.compileGroupIndex] === group &&
            source.path.endsWith(group.language === "C" ? ".c" : ".cpp"),
          "Native compile-group identity differs",
        );
        observedIndexes.push(i);
      }
    }
    cppRequire(
      cppSame(
        observedIndexes.map(String),
        t.sources.map((_, i) => String(i)),
      ),
      "Native compile groups omit or repeat a source",
    );
    const ids = target.dependencies.map(
      (n) => refs.find((t) => t.name === n)!.id,
    );
    cppRequire(
      cppSame(
        (t.dependencies ?? []).map((d) => d.id),
        ids,
      ) &&
        cppSame(
          (t.linkLibraries ?? []).map((d) => d.id),
          ids,
        ),
      "Native link dependency scope differs",
    );
    const binary =
      target.type === "static" ? `lib${target.name}.a` : target.name;
    cppRequire(
      t.artifacts[0]!.path === binary,
      "Native artifact identity differs",
    );
    used.add(api + ref.jsonFile);
  }
  const database = z
    .array(
      z.strictObject({
        directory: z.literal(build),
        file: string,
        command: string,
        output: string,
      }),
    )
    .parse(JSON.parse(artifact("compile_commands.json")));
  const units = cppUnits(c);
  cppRequire(
    database.length === units.length,
    "Native compilation database count differs",
  );
  for (const unit of units) {
    const rows = database.filter(
      (r) => r.file === path.join(workspace, unit.file),
    );
    cppRequire(
      rows.length === 1 &&
        rows[0]!.output === unit.object &&
        JSON.stringify(cppWords(rows[0]!.command)) ===
          JSON.stringify([
            entry(unit.compiler),
            ...cppCompileArgs(c, workspace, build, unit),
          ]),
      "Native compilation database arguments differ",
    );
  }
  return { refs, used };
}
export function cppCTestScope(
  text: string,
  c: CppToolsConfig,
  workspace: string,
  build: string,
) {
  const data = z
    .object({
      kind: z.literal("ctestInfo"),
      version: z.object({ major: z.literal(1), minor: z.literal(0) }),
      backtraceGraph: z.object({
        commands: strings,
        files: strings,
        nodes: z.array(
          z.object({
            command: index.optional(),
            file: index.optional(),
            line: z.number().int().positive().optional(),
            parent: index.optional(),
          }),
        ),
      }),
      tests: z.array(
        z.object({
          name: string,
          command: strings,
          backtrace: index,
          properties: z.array(z.object({ name: string, value: z.unknown() })),
        }),
      ),
    })
    .parse(JSON.parse(text));
  cppRequire(
    c.tests.length > 0 &&
      cppSame(
        data.tests.map((t) => t.name),
        c.tests.map((t) => t.name),
      ),
    "Native CTest registration scope differs",
  );
  const lines = cppCmake(c).split("\n");
  for (const test of data.tests) {
    const declared = c.tests.find((t) => t.name === test.name)!;
    cppRequire(
      JSON.stringify(test.command) ===
        JSON.stringify([path.join(build, declared.target)]),
      "Native CTest command differs",
    );
    cppRequire(
      cppSame(
        test.properties.map((p) => p.name),
        ["TIMEOUT", "WORKING_DIRECTORY"],
      ) &&
        test.properties.find((p) => p.name === "TIMEOUT")!.value === 10 &&
        test.properties.find((p) => p.name === "WORKING_DIRECTORY")!.value ===
          build,
      "Unexpected native CTest property",
    );
    const node = data.backtraceGraph.nodes[test.backtrace];
    cppRequire(
      node &&
        node.command !== undefined &&
        node.file !== undefined &&
        node.line !== undefined &&
        data.backtraceGraph.commands[node.command] === "add_test" &&
        data.backtraceGraph.files[node.file] ===
          path.join(workspace, "CMakeLists.txt") &&
        lines[node.line - 1] ===
          `add_test(NAME ${test.name} COMMAND ${declared.target})`,
      "Native CTest physical registration differs",
    );
  }
  return data.tests.map((t) => t.name);
}
