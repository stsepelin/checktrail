import { swiftExtensionsConfigSchema } from "../src/swift-extensions-contract.js";
/** Original synthetic inputs; policy-only SDK pin is never a native receipt. */
export const swiftExtensionsOriginalInputs: Record<string, string> = {
  "Package.swift":
    '// swift-tools-version: 6.2\nimport PackageDescription\n#if os(Linux)\nlet producerPath = "Packages/Producer"\n#else\nlet producerPath = "Packages/Adjacent"\n#endif\nlet package = Package(name:"OriginalConsumer",products:[.library(name:"OriginalConsumer",targets:["OriginalConsumer"])],dependencies:[.package(path:producerPath)],targets:[.target(name:"OriginalConsumer",dependencies:[.product(name:"OriginalProducer",package:"producer")],plugins:[.plugin(name:"OriginalGenerate")]),.executableTarget(name:"OriginalGenerator",path:"Tools/OriginalGenerator"),.plugin(name:"OriginalGenerate",capability:.buildTool(),dependencies:["OriginalGenerator"],path:"Plugins/OriginalGenerate"),.testTarget(name:"OriginalConsumerTests",dependencies:["OriginalConsumer"])])\n',
  "Packages/Producer/Package.swift":
    '// swift-tools-version: 6.2\nimport PackageDescription\nlet package = Package(name:"OriginalProducer",products:[.library(name:"OriginalProducer",targets:["OriginalProducer"])],targets:[.target(name:"OriginalProducer")])\n',
  "Packages/Producer/Sources/OriginalProducer/Producer.swift":
    "public enum OriginalProducer { public static func nextQuantity(_ value:Int)->Int { value + 1 } }\n",
  "Plugins/OriginalGenerate/plugin.swift":
    'import PackagePlugin\nimport Foundation\n@main struct OriginalGenerate: BuildToolPlugin {\nfunc createBuildCommands(context:PluginContext,target:Target) throws -> [Command] {\n let output=context.pluginWorkDirectoryURL.appending(path:"OriginalGenerated.swift")\n return [.buildCommand(displayName:"Original source generator",executable:try context.tool(named:"OriginalGenerator").url,arguments:[output.path],outputFiles:[output])]\n}\n}\n',
  "Sources/OriginalConsumer/Consumer.swift":
    "import Foundation\nimport Glibc\nimport OriginalProducer\npublic enum OriginalConsumer { public static var nativeProcessId:Int32 { getpid() }; public static func values(_ value:Int)->Data { Data([UInt8(OriginalProducer.nextQuantity(value)),UInt8(OriginalGenerated.value)]) } }\n",
  "Tests/OriginalConsumerTests/QuantityTestingTests.swift":
    "import Testing\nimport Foundation\n@testable import OriginalConsumer\n@Test func originalTestingValue() { #expect(Array(OriginalConsumer.values(2)) == [3,5]) }\n@Test(arguments:[2,4]) func originalTestingParameterized(value:Int) { #expect(Array(OriginalConsumer.values(value)) == [UInt8(value+1),5]) }\n@Test func originalLinuxHeaderValue() { #expect(OriginalConsumer.nativeProcessId > 0) }\n",
  "Tests/OriginalConsumerTests/QuantityXCTests.swift":
    "import XCTest\nimport Foundation\n@testable import OriginalConsumer\nfinal class OriginalQuantityXCTests:XCTestCase {\n func testProducerValue() { XCTAssertEqual(Array(OriginalConsumer.values(2)),[3,5]) }\n func testLinuxHeaderValue() { XCTAssertGreaterThan(OriginalConsumer.nativeProcessId,0) }\n func testAdjacentValue() { XCTAssertEqual(Array(OriginalConsumer.values(4)),[5,5]) }\n}\n",
  "Tools/OriginalGenerator/main.swift":
    'import Foundation\nlet output = CommandLine.arguments[1]\ntry "public enum OriginalGenerated { public static let value = 5 }\\n".write(toFile:output,atomically:true,encoding:.utf8)\n',
};
export const swiftExtensionsDeclaredConfig = () =>
  swiftExtensionsConfigSchema.parse({
    schemaVersion: 1,
    profile: "declared-local-packages-build-tool-generated-sdk-v1",
    swiftVersion: "6.2.3",
    toolsVersion: "6.2.0",
    platform: "aarch64-unknown-linux-gnu",
    packages: [
      {
        path: ".",
        identity: "project",
        name: "OriginalConsumer",
        dependencies: [
          {
            identity: "producer",
            path: "Packages/Producer",
          },
        ],
        products: [
          {
            name: "OriginalConsumer",
            type: "library",
            targets: ["OriginalConsumer"],
            implicit: false,
          },
          {
            name: "OriginalGenerator",
            type: "executable",
            targets: ["OriginalGenerator"],
            implicit: true,
          },
        ],
        targets: [
          {
            name: "OriginalConsumer",
            type: "regular",
            path: "Sources/OriginalConsumer",
            sources: ["Sources/OriginalConsumer/Consumer.swift"],
            dependencies: [
              {
                kind: "product",
                name: "OriginalProducer",
                package: "producer",
              },
            ],
            plugins: ["OriginalGenerate"],
          },
          {
            name: "OriginalGenerator",
            type: "executable",
            path: "Tools/OriginalGenerator",
            sources: ["Tools/OriginalGenerator/main.swift"],
            dependencies: [],
            plugins: [],
          },
          {
            name: "OriginalGenerate",
            type: "plugin",
            path: "Plugins/OriginalGenerate",
            sources: ["Plugins/OriginalGenerate/plugin.swift"],
            dependencies: [
              {
                kind: "target",
                name: "OriginalGenerator",
              },
            ],
            plugins: [],
          },
          {
            name: "OriginalConsumerTests",
            type: "test",
            path: "Tests/OriginalConsumerTests",
            sources: [
              "Tests/OriginalConsumerTests/QuantityTestingTests.swift",
              "Tests/OriginalConsumerTests/QuantityXCTests.swift",
            ],
            dependencies: [
              {
                kind: "target",
                name: "OriginalConsumer",
              },
            ],
            plugins: [],
          },
        ],
      },
      {
        path: "Packages/Producer",
        identity: "producer",
        name: "OriginalProducer",
        dependencies: [],
        products: [
          {
            name: "OriginalProducer",
            type: "library",
            targets: ["OriginalProducer"],
            implicit: false,
          },
        ],
        targets: [
          {
            name: "OriginalProducer",
            type: "regular",
            path: "Sources/OriginalProducer",
            sources: ["Sources/OriginalProducer/Producer.swift"],
            dependencies: [],
            plugins: [],
          },
        ],
      },
    ],
    generated: [
      {
        package: "project",
        target: "OriginalConsumer",
        plugin: "OriginalGenerate",
        generator: "OriginalGenerator",
        file: "OriginalGenerated.swift",
      },
    ],
    tests: {
      xctest: ["Tests/OriginalConsumerTests/QuantityXCTests.swift"],
      testing: ["Tests/OriginalConsumerTests/QuantityTestingTests.swift"],
      support: [],
    },
    swiftlintVersion: "0.65.1",
    rules: ["force_try", "force_unwrapping"],
    sdk: [
      {
        root: "swift",
        path: "linux/OriginalSynthetic.swiftinterface",
        bytes: 1,
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
    ],
  });
/** Native Swift 6.2.3 manifest/describe observations of these original inputs. */
export const swiftExtensionsOriginalGraph = () =>
  structuredClone([
    {
      identity: "project",
      manifest:
        '{\n  "cLanguageStandard" : null,\n  "cxxLanguageStandard" : null,\n  "dependencies" : [\n    {\n      "fileSystem" : [\n        {\n          "identity" : "producer",\n          "path" : "/tmp/project/Packages/Producer",\n          "productFilter" : null,\n          "traits" : [\n            {\n              "name" : "default"\n            }\n          ]\n        }\n      ]\n    }\n  ],\n  "name" : "OriginalConsumer",\n  "packageKind" : {\n    "root" : [\n      "/tmp/project"\n    ]\n  },\n  "pkgConfig" : null,\n  "platforms" : [\n\n  ],\n  "products" : [\n    {\n      "name" : "OriginalConsumer",\n      "settings" : [\n\n      ],\n      "targets" : [\n        "OriginalConsumer"\n      ],\n      "type" : {\n        "library" : [\n          "automatic"\n        ]\n      }\n    }\n  ],\n  "providers" : null,\n  "swiftLanguageVersions" : null,\n  "targets" : [\n    {\n      "dependencies" : [\n        {\n          "product" : [\n            "OriginalProducer",\n            "producer",\n            null,\n            null\n          ]\n        }\n      ],\n      "exclude" : [\n\n      ],\n      "name" : "OriginalConsumer",\n      "packageAccess" : true,\n      "pluginUsages" : [\n        {\n          "plugin" : [\n            "OriginalGenerate",\n            null\n          ]\n        }\n      ],\n      "resources" : [\n\n      ],\n      "settings" : [\n\n      ],\n      "type" : "regular"\n    },\n    {\n      "dependencies" : [\n\n      ],\n      "exclude" : [\n\n      ],\n      "name" : "OriginalGenerator",\n      "packageAccess" : true,\n      "path" : "Tools/OriginalGenerator",\n      "resources" : [\n\n      ],\n      "settings" : [\n\n      ],\n      "type" : "executable"\n    },\n    {\n      "dependencies" : [\n        {\n          "byName" : [\n            "OriginalGenerator",\n            null\n          ]\n        }\n      ],\n      "exclude" : [\n\n      ],\n      "name" : "OriginalGenerate",\n      "packageAccess" : true,\n      "path" : "Plugins/OriginalGenerate",\n      "pluginCapability" : {\n        "buildTool" : null\n      },\n      "resources" : [\n\n      ],\n      "settings" : [\n\n      ],\n      "type" : "plugin"\n    },\n    {\n      "dependencies" : [\n        {\n          "byName" : [\n            "OriginalConsumer",\n            null\n          ]\n        }\n      ],\n      "exclude" : [\n\n      ],\n      "name" : "OriginalConsumerTests",\n      "packageAccess" : true,\n      "resources" : [\n\n      ],\n      "settings" : [\n\n      ],\n      "type" : "test"\n    }\n  ],\n  "toolsVersion" : {\n    "_version" : "6.2.0"\n  },\n  "traits" : [\n\n  ]\n}\n',
      describe:
        '{\n  "dependencies" : [\n    {\n      "identity" : "producer",\n      "path" : "/tmp/project/Packages/Producer",\n      "type" : "fileSystem"\n    }\n  ],\n  "manifest_display_name" : "OriginalConsumer",\n  "name" : "OriginalConsumer",\n  "path" : "/tmp/project",\n  "platforms" : [\n\n  ],\n  "products" : [\n    {\n      "name" : "OriginalConsumer",\n      "targets" : [\n        "OriginalConsumer"\n      ],\n      "type" : {\n        "library" : [\n          "automatic"\n        ]\n      }\n    },\n    {\n      "name" : "OriginalGenerator",\n      "targets" : [\n        "OriginalGenerator"\n      ],\n      "type" : {\n        "executable" : null\n      }\n    }\n  ],\n  "targets" : [\n    {\n      "c99name" : "OriginalGenerator",\n      "module_type" : "SwiftTarget",\n      "name" : "OriginalGenerator",\n      "path" : "Tools/OriginalGenerator",\n      "product_memberships" : [\n        "OriginalConsumer",\n        "OriginalGenerator"\n      ],\n      "sources" : [\n        "main.swift"\n      ],\n      "type" : "executable"\n    },\n    {\n      "c99name" : "OriginalGenerate",\n      "module_type" : "PluginTarget",\n      "name" : "OriginalGenerate",\n      "path" : "Plugins/OriginalGenerate",\n      "plugin_capability" : {\n        "type" : "buildTool"\n      },\n      "product_memberships" : [\n        "OriginalConsumer"\n      ],\n      "sources" : [\n        "plugin.swift"\n      ],\n      "target_dependencies" : [\n        "OriginalGenerator"\n      ],\n      "type" : "plugin"\n    },\n    {\n      "c99name" : "OriginalConsumerTests",\n      "module_type" : "SwiftTarget",\n      "name" : "OriginalConsumerTests",\n      "path" : "Tests/OriginalConsumerTests",\n      "sources" : [\n        "QuantityTestingTests.swift",\n        "QuantityXCTests.swift"\n      ],\n      "target_dependencies" : [\n        "OriginalConsumer"\n      ],\n      "type" : "test"\n    },\n    {\n      "c99name" : "OriginalConsumer",\n      "module_type" : "SwiftTarget",\n      "name" : "OriginalConsumer",\n      "path" : "Sources/OriginalConsumer",\n      "product_dependencies" : [\n        "OriginalProducer"\n      ],\n      "product_memberships" : [\n        "OriginalConsumer"\n      ],\n      "sources" : [\n        "Consumer.swift"\n      ],\n      "target_dependencies" : [\n        "OriginalGenerate"\n      ],\n      "type" : "library"\n    }\n  ],\n  "tools_version" : "6.2"\n}\n',
    },
    {
      identity: "producer",
      manifest:
        '{\n  "cLanguageStandard" : null,\n  "cxxLanguageStandard" : null,\n  "dependencies" : [\n\n  ],\n  "name" : "OriginalProducer",\n  "packageKind" : {\n    "root" : [\n      "/tmp/project/Packages/Producer"\n    ]\n  },\n  "pkgConfig" : null,\n  "platforms" : [\n\n  ],\n  "products" : [\n    {\n      "name" : "OriginalProducer",\n      "settings" : [\n\n      ],\n      "targets" : [\n        "OriginalProducer"\n      ],\n      "type" : {\n        "library" : [\n          "automatic"\n        ]\n      }\n    }\n  ],\n  "providers" : null,\n  "swiftLanguageVersions" : null,\n  "targets" : [\n    {\n      "dependencies" : [\n\n      ],\n      "exclude" : [\n\n      ],\n      "name" : "OriginalProducer",\n      "packageAccess" : true,\n      "resources" : [\n\n      ],\n      "settings" : [\n\n      ],\n      "type" : "regular"\n    }\n  ],\n  "toolsVersion" : {\n    "_version" : "6.2.0"\n  },\n  "traits" : [\n\n  ]\n}\n',
      describe:
        '{\n  "dependencies" : [\n\n  ],\n  "manifest_display_name" : "OriginalProducer",\n  "name" : "OriginalProducer",\n  "path" : "/tmp/project/Packages/Producer",\n  "platforms" : [\n\n  ],\n  "products" : [\n    {\n      "name" : "OriginalProducer",\n      "targets" : [\n        "OriginalProducer"\n      ],\n      "type" : {\n        "library" : [\n          "automatic"\n        ]\n      }\n    }\n  ],\n  "targets" : [\n    {\n      "c99name" : "OriginalProducer",\n      "module_type" : "SwiftTarget",\n      "name" : "OriginalProducer",\n      "path" : "Sources/OriginalProducer",\n      "product_memberships" : [\n        "OriginalProducer"\n      ],\n      "sources" : [\n        "Producer.swift"\n      ],\n      "type" : "library"\n    }\n  ],\n  "tools_version" : "6.2"\n}\n',
    },
  ]);

export async function swiftExtensionsFixture(
  t: import("node:test").TestContext,
  mode = "xctest",
) {
  const { fixture } = await import("./helpers.js"),
    { readFile } = await import("node:fs/promises");
  const file = process.env.CHECKTRAIL_SWIFT_EXTENSIONS_SDK;
  if (!file) throw Error("Selected native SDK policy unavailable");
  const config = swiftExtensionsDeclaredConfig();
  config.sdk = JSON.parse(await readFile(file, "utf8")).pins;
  const root = await fixture(t, {
    ...swiftExtensionsOriginalInputs,
    "checktrail.swift-extensions.json": JSON.stringify(config),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["swift." + mode + "-extensions"] }],
    }),
  });
  return { root, config };
}
export const swiftExtensionsNative = {
  skip: process.env.CHECKTRAIL_SWIFT_EXTENSIONS_SDK
    ? false
    : "Pinned Swift extension runtime and SDK inventory not selected",
  timeout: 1200000,
};
