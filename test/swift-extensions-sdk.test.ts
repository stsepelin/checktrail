import assert from "node:assert/strict";
import { test } from "node:test";
import {
  swiftExtensionsSdkReferences,
  swiftExtensionsSdkAddress,
} from "../src/swift-extensions-sdk.js";
import { swiftExtensionsDeclaredConfig } from "./swift-extensions-fixture.js";
const virtualMap = "/usr/include/module.modulemap",
  virtualHeader = "/usr/include/SwiftGlibc.h";
const realMap = "/usr/lib/swift/linux/aarch64/glibc.modulemap",
  realHeader = "/usr/lib/swift/linux/aarch64/SwiftGlibc.h";
const diagnostics = () =>
  `clang importer redirected file mappings:\n   mapping real file '${realMap}' to virtual file '${virtualMap}'\n   mapping real file '${realHeader}' to virtual file '${virtualHeader}'\n`;
const source = "Sources/OriginalConsumer/Consumer.swift",
  modulePath = "/tmp/scratch/Modules/OriginalProducer.swiftmodule";
const fixture = () => {
  const config = swiftExtensionsDeclaredConfig();
  const paths = [
    realMap,
    realHeader,
    "/usr/include/unistd.h",
    "/usr/lib/swift/linux/Glibc.swiftmodule/aarch64-unknown-linux-gnu.private.swiftinterface",
    "/usr/lib/swift/linux/Glibc.swiftmodule/aarch64-unknown-linux-gnu.swiftmodule",
    "/usr/lib/swift/host/plugins/libSwiftMacros.so",
  ];
  config.sdk = paths.map((file) => ({
    ...swiftExtensionsSdkAddress(file),
    bytes: 1,
    sha256: "0".repeat(64),
  }));
  const scan = {
    mainModuleName: "OriginalConsumer",
    modules: [
      { swift: "OriginalConsumer" },
      {
        modulePath: "OriginalConsumer.swiftmodule",
        sourceFiles: ["/tmp/project/" + source],
        directDependencies: [
          { swiftPrebuiltExternal: "OriginalProducer" },
          { swift: "Glibc" },
        ],
        linkLibraries: [],
        imports: [],
        details: {
          swift: {
            commandLine: [],
            contextHash: "original",
            userModuleVersion: "",
            macroDependencies: [
              {
                moduleName: "SwiftMacros",
                libraryPath: paths[5],
                executablePath: "",
              },
            ],
            sourceImportedDependencies: [
              { swiftPrebuiltExternal: "OriginalProducer" },
              { swift: "Glibc" },
            ],
            isFramework: false,
          },
        },
      },
      { swiftPrebuiltExternal: "OriginalProducer" },
      {
        modulePath,
        directDependencies: [],
        linkLibraries: [],
        imports: [],
        details: {
          swiftPrebuiltExternal: {
            compiledModulePath: modulePath,
            userModuleVersion: "0.0.0.0",
            macroDependencies: [],
            isFramework: false,
          },
        },
      },
      { swift: "Glibc" },
      {
        modulePath: "/tmp/cache/Glibc.swiftmodule",
        sourceFiles: [],
        directDependencies: [{ clang: "SwiftGlibc" }],
        linkLibraries: [],
        imports: [],
        details: {
          swift: {
            moduleInterfacePath: paths[3],
            compiledModuleCandidates: [paths[4]],
            commandLine: [],
            contextHash: "original",
            userModuleVersion: "",
            macroDependencies: [],
            isFramework: false,
          },
        },
      },
      { clang: "SwiftGlibc" },
      {
        modulePath: "/tmp/cache/SwiftGlibc.pcm",
        sourceFiles: [virtualMap, virtualHeader, "/usr/include/unistd.h"],
        directDependencies: [],
        linkLibraries: [],
        imports: [],
        details: {
          clang: {
            moduleMapPath: virtualMap,
            contextHash: "original",
            commandLine: [],
          },
        },
      },
    ],
  };
  return { config, scan };
};
const read = (
  config: ReturnType<typeof fixture>["config"],
  scan: unknown,
  logs = diagnostics(),
) =>
  swiftExtensionsSdkReferences(
    config,
    "OriginalConsumer",
    "/tmp/project",
    "/tmp",
    [source],
    JSON.stringify(scan),
    logs,
  );
test("Swift SDK synthetic graph binds virtual module maps and headers to their physical byte policies", () => {
  const { config, scan } = fixture(),
    r = read(config, scan);
  assert.equal(r.modules.length, 4);
  assert.equal(r.sdk.length, 6);
  assert.equal(r.owned.length, 4);
  assert.ok(
    r.sdk.some(
      (p) => p.root === "swift" && p.path === "linux/aarch64/glibc.modulemap",
    ),
  );
  assert.ok(
    !r.sdk.some(
      (p) =>
        p.root === "include" &&
        ["module.modulemap", "SwiftGlibc.h"].includes(p.path),
    ),
  );
  assert.deepEqual(read(config, scan, diagnostics() + diagnostics()), r);
});
test("Swift SDK virtual-address pins cannot substitute for missing physical mapped file pins", () => {
  for (const physical of [realMap, realHeader]) {
    const { config, scan } = fixture(),
      address = swiftExtensionsSdkAddress(physical);
    config.sdk = config.sdk.filter(
      (p) => p.root !== address.root || p.path !== address.path,
    );
    config.sdk.push({
      root: "include",
      path: physical === realMap ? "module.modulemap" : "SwiftGlibc.h",
      bytes: 1,
      sha256: "0".repeat(64),
    });
    assert.throws(() => read(config, scan), /no physical byte pin/);
  }
});
test("Swift SDK mapping diagnostics reject omissions conflicting targets adjacent names and unsupported overlays", () => {
  const { config, scan } = fixture();
  for (const logs of [
    "",
    diagnostics()
      .split("\n")
      .filter((l) => !l.includes(virtualHeader))
      .join("\n"),
    diagnostics().replace(realHeader, realHeader + "Adjacent"),
    diagnostics().replace(virtualHeader, virtualHeader + "Adjacent"),
    diagnostics() +
      `   mapping real file '${realMap}' to virtual file '/usr/include/Adjacent.modulemap'\n`,
    diagnostics() +
      "clang importer overriding file '/tmp/project/Original.h' with the following contents:\n",
  ])
    assert.throws(() => read(config, scan, logs));
});
test("Swift SDK native graph rejects omitted repeated orphan malformed and escaping dependency evidence", () => {
  const { config, scan } = fixture();
  const change = (
    input: unknown,
    keys: (string | number)[],
    value: unknown,
  ) => {
    let row = input;
    for (const key of keys.slice(0, -1)) {
      assert.ok(row && typeof row === "object");
      row = Reflect.get(row, key);
    }
    assert.ok(row && typeof row === "object");
    Reflect.set(row, keys.at(-1)!, value);
  };
  const edits: ((input: typeof scan) => void)[] = [
    (x) => {
      x.modules.splice(4, 2);
    },
    (x) => {
      x.modules.push(x.modules[2]!, x.modules[3]!);
    },
    (x) => {
      x.modules.pop();
    },
    (x) => {
      x.mainModuleName = "OriginalConsumerAdjacent";
    },
    (x) =>
      change(
        x,
        ["modules", 1, "sourceFiles"],
        ["/tmp/project/OriginalAdjacent.swift"],
      ),
    (x) => change(x, ["modules", 7, "sourceFiles"], []),
    (x) =>
      change(
        x,
        ["modules", 7, "sourceFiles"],
        [virtualMap, virtualHeader, "/tmp/scratch/Adjacent.h"],
      ),
    (x) =>
      change(
        x,
        ["modules", 7, "sourceFiles"],
        [virtualMap, virtualHeader, "/usr/include/../private/Secret.h"],
      ),
    (x) =>
      change(
        x,
        ["modules", 5, "details", "swift", "compiledModuleCandidates"],
        [],
      ),
    (x) =>
      change(
        x,
        [
          "modules",
          1,
          "details",
          "swift",
          "macroDependencies",
          0,
          "executablePath",
        ],
        "/usr/lib/swift/host/Adjacent",
      ),
    (x) =>
      change(x, ["modules", 3, "details"], {
        clang: {
          moduleMapPath: virtualMap,
          contextHash: "original",
          commandLine: [],
        },
      }),
  ];
  for (const edit of edits) {
    const input = structuredClone(scan);
    edit(input);
    assert.throws(() => read(config, input));
  }
  const orphan = structuredClone(scan);
  change(orphan, ["modules", 1, "directDependencies"], [{ swift: "Glibc" }]);
  assert.throws(() => read(config, orphan), /orphan/);
});
test("Swift SDK interface-only modules retain their physical interface pin without inventing a prebuilt candidate", () => {
  const { config, scan } = fixture();
  config.sdk = config.sdk.filter((p) => !p.path.endsWith(".swiftmodule"));
  const row = scan.modules[5]!;
  assert.ok("details" in row && "swift" in row.details);
  row.details.swift.compiledModuleCandidates = [];
  const result = read(config, scan);
  assert.ok(result.sdk.some((p) => p.path.endsWith(".swiftinterface")));
  assert.equal(result.sdk.length, 5);
});
test("Swift SDK address matching preserves exact directory boundaries and the measured Clang alias", () => {
  assert.deepEqual(
    swiftExtensionsSdkAddress("/usr/lib/swift/clang/include/module.modulemap"),
    { root: "clang", path: "include/module.modulemap" },
  );
  for (const file of [
    "/usr/lib/swiftAdjacent/linux/Original.swiftmodule",
    "/usr/includeAdjacent/Original.h",
    "/usr/lib/clang/170/include/Original.h",
    "/usr/include/../private/Original.h",
  ])
    assert.throws(() => swiftExtensionsSdkAddress(file));
});
