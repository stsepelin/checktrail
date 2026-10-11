import assert from "node:assert/strict";
import { test } from "node:test";
import {
  swiftExtensionsConfigSchema,
  swiftExtensionsScope,
} from "../src/swift-extensions-contract.js";
import { swiftExtensionsNativeGraph } from "../src/swift-extensions-graph.js";
import {
  swiftExtensionsOriginalInputs,
  swiftExtensionsDeclaredConfig,
  swiftExtensionsOriginalGraph,
} from "./swift-extensions-fixture.js";
const files = () => Object.keys(swiftExtensionsOriginalInputs);
test("Swift extension scope covers local packages generators plugins and both test frameworks without evaluating manifests", () => {
  const c = swiftExtensionsDeclaredConfig(),
    scope = swiftExtensionsScope(c, files());
  assert.equal(scope.manifests.length, 2);
  assert.equal(scope.sources.length, 6);
  assert.equal(scope.tests.length, 2);
  assert.equal(scope.packages.size, 2);
  swiftExtensionsNativeGraph(c, "/tmp/project", swiftExtensionsOriginalGraph());
});
test("Swift extension declarations reject escaping missing duplicate disconnected and cyclic scopes", () => {
  type Config = ReturnType<typeof swiftExtensionsDeclaredConfig>;
  const edits: ((c: Config) => void)[] = [
    (c) => {
      c.packages[1]!.identity = c.packages[0]!.identity;
    },
    (c) => {
      c.packages[0]!.dependencies[0]!.path = "Packages/Adjacent";
    },
    (c) => {
      c.packages[0]!.dependencies = [];
      c.packages[0]!.targets[0]!.dependencies = [];
    },
    (c) => {
      c.packages[0]!.targets[0]!.dependencies = [
        { kind: "target", name: "OriginalConsumerTests" },
      ];
    },
    (c) => {
      c.packages[0]!.targets[0]!.plugins = ["OriginalGenerateAdjacent"];
    },
    (c) => {
      c.generated[0]!.generator = "OriginalGeneratorAdjacent";
    },
    (c) => {
      c.packages[0]!.targets[2]!.dependencies = [
        { kind: "target", name: "OriginalConsumer" },
      ];
    },
    (c) => {
      c.tests.xctest = [];
    },
    (c) => {
      c.packages[0]!.targets[0]!.sources.push(
        c.packages[0]!.targets[0]!.sources[0]!,
      );
    },
    (c) => {
      c.sdk.push(c.sdk[0]!);
    },
    (c) => {
      c.packages[0]!.products[0]!.implicit = true;
    },
  ];
  for (const edit of edits) {
    const c = swiftExtensionsDeclaredConfig();
    edit(c);
    assert.throws(() => swiftExtensionsScope(c, files()));
  }
  const c = swiftExtensionsDeclaredConfig();
  assert.throws(() =>
    swiftExtensionsScope(
      c,
      files().filter((f) => f !== "Packages/Producer/Package.swift"),
    ),
  );
  assert.throws(() =>
    swiftExtensionsScope(c, [
      ...files(),
      "Sources/OriginalConsumer/Unlisted.swift",
    ]),
  );
  for (const key of ["trusted", "execute", "allowNetwork"])
    assert.equal(
      swiftExtensionsConfigSchema.safeParse({ ...c, [key]: true }).success,
      false,
    );
  const escape = structuredClone(c);
  escape.generated[0]!.file = "../Escape.swift";
  assert.equal(swiftExtensionsConfigSchema.safeParse(escape).success, false);
});
test("Swift extension native graph rejects changed evaluated dependencies generated plugins sources implicit products and transitive membership", () => {
  const c = swiftExtensionsDeclaredConfig();
  type Graph = ReturnType<typeof swiftExtensionsOriginalGraph>;
  const modify = (
    record: Graph[number],
    field: "manifest" | "describe",
    keys: (string | number)[],
    value: unknown,
  ) => {
    const parsed: unknown = JSON.parse(record[field]);
    let current = parsed;
    for (const key of keys.slice(0, -1)) {
      assert.ok(current !== null && typeof current === "object");
      current = Reflect.get(current, key);
    }
    assert.ok(current !== null && typeof current === "object");
    Reflect.set(current, keys.at(-1)!, value);
    record[field] = JSON.stringify(parsed);
  };
  const edits: ((records: Graph) => void)[] = [
    (r) => {
      r.pop();
    },
    (r) =>
      modify(
        r[0]!,
        "manifest",
        ["dependencies", 0, "fileSystem", 0, "path"],
        "/tmp/project/Packages/Adjacent",
      ),
    (r) =>
      modify(r[0]!, "manifest", ["dependencies", 0], {
        sourceControl: [{ location: "https://example.invalid/original.git" }],
      }),
    (r) =>
      modify(
        r[0]!,
        "manifest",
        ["targets", 0, "dependencies", 0, "product", 0],
        "OriginalProducerAdjacent",
      ),
    (r) => modify(r[0]!, "manifest", ["targets", 0, "pluginUsages"], []),
    (r) =>
      modify(r[0]!, "manifest", ["targets", 2, "pluginCapability"], {
        command: {},
      }),
    (r) => modify(r[0]!, "describe", ["products"], []),
    (r) =>
      modify(
        r[0]!,
        "describe",
        ["targets", 0, "product_memberships"],
        ["OriginalGenerator"],
      ),
    (r) =>
      modify(
        r[0]!,
        "describe",
        ["targets", 3, "sources"],
        ["Consumer.swift", "OriginalGenerated.swift"],
      ),
    (r) =>
      modify(r[0]!, "describe", ["targets", 3, "product_dependencies"], []),
    (r) => modify(r[1]!, "describe", ["targets", 0, "sources"], []),
  ];
  for (const edit of edits) {
    const r = swiftExtensionsOriginalGraph();
    edit(r);
    assert.throws(() => swiftExtensionsNativeGraph(c, "/tmp/project", r));
  }
});
test("Swift extension native graph accepts valid declaration ordering and explicit adjacent text without changing its cohort", () => {
  const c = swiftExtensionsDeclaredConfig(),
    r = swiftExtensionsOriginalGraph();
  c.packages[0]!.targets.reverse();
  c.packages[0]!.products.reverse();
  for (const row of r) {
    for (const key of ["manifest", "describe"] as const) {
      const v = JSON.parse(row[key]);
      v.targets.reverse();
      v.products.reverse();
      row[key] = JSON.stringify(v);
    }
  }
  swiftExtensionsScope(c, files().reverse());
  swiftExtensionsNativeGraph(c, "/tmp/project", r.reverse());
  assert.match(
    swiftExtensionsOriginalInputs["Package.swift"]!,
    /#if os\(Linux\)/,
  );
  assert.match(
    swiftExtensionsOriginalInputs["Sources/OriginalConsumer/Consumer.swift"]!,
    /import Glibc/,
  );
});
