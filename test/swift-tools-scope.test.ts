import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, unlink, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { inventory as captureInventory } from "../src/inventory.js";
import { discover } from "../src/adapters.js";
import { mavenHash } from "../src/maven.js";
import {
  swiftToolsConfigSchema,
  swiftToolsScope,
  swiftToolsInputs,
} from "../src/swift-tools.js";
const valid = () =>
  swiftToolsConfigSchema.parse({
    schemaVersion: 1,
    swiftVersion: "6.2.3",
    toolsVersion: "6.2.0",
    platform: "aarch64-unknown-linux-gnu",
    packageName: "OriginalQuantity",
    products: [
      {
        name: "OriginalQuantity",
        type: "library",
        targets: ["OriginalQuantity"],
      },
    ],
    targets: [
      {
        name: "OriginalQuantity",
        type: "regular",
        path: "Sources/OriginalQuantity",
        sources: ["Sources/OriginalQuantity/Quantity.swift"],
        dependencies: [],
      },
      {
        name: "OriginalQuantityTests",
        type: "test",
        path: "Tests/OriginalQuantityTests",
        sources: ["Tests/OriginalQuantityTests/QuantityTests.swift"],
        dependencies: ["OriginalQuantity"],
      },
    ],
    tests: {
      framework: "xctest",
      files: ["Tests/OriginalQuantityTests/QuantityTests.swift"],
      support: [],
    },
    swiftlintVersion: "0.65.1",
    rules: ["force_try", "force_unwrapping"],
  });
const inventory = [
  "Package.swift",
  "Sources/OriginalQuantity/Quantity.swift",
  "Tests/OriginalQuantityTests/QuantityTests.swift",
];
test("Swift declarative scope reconciles all sources products dependencies and test targets without evaluating a manifest", () => {
  assert.deepEqual(
    swiftToolsScope(valid(), inventory).sources,
    inventory.slice(1),
  );
  const changed = valid();
  changed.tests.framework = "swift-testing";
  assert.deepEqual(swiftToolsScope(changed, inventory).testSources, [
    inventory[2],
  ]);
  const invalid = [
    (c: ReturnType<typeof valid>) => {
      c.targets.push(c.targets[0]!);
    },
    (c: ReturnType<typeof valid>) => {
      c.products.push(c.products[0]!);
    },
    (c: ReturnType<typeof valid>) => {
      c.rules.push("force_try");
    },
    (c: ReturnType<typeof valid>) => {
      c.targets[0]!.sources = [inventory[2]!];
    },
    (c: ReturnType<typeof valid>) => {
      c.targets[0]!.path = "Sources/OriginalQuantityNearMiss";
    },
    (c: ReturnType<typeof valid>) => {
      c.targets[1]!.dependencies = ["OriginalQuantityNearMiss"];
    },
    (c: ReturnType<typeof valid>) => {
      c.targets[0]!.dependencies = ["OriginalQuantityTests"];
    },
    (c: ReturnType<typeof valid>) => {
      c.products[0]!.targets = ["OriginalQuantityTests"];
    },
    (c: ReturnType<typeof valid>) => {
      c.products[0]!.type = "executable";
    },
    (c: ReturnType<typeof valid>) => {
      c.tests.files = [];
    },
    (c: ReturnType<typeof valid>) => {
      c.tests.support = [...c.tests.files];
    },
  ];
  for (const edit of invalid) {
    const config = valid();
    edit(config);
    assert.throws(() => swiftToolsScope(config, inventory));
  }
  assert.throws(() => swiftToolsScope(valid(), inventory.slice(1)));
  assert.throws(() =>
    swiftToolsScope(valid(), [
      ...inventory,
      "Sources/OriginalQuantity/Hidden.swift",
    ]),
  );
  assert.throws(() =>
    swiftToolsConfigSchema.parse({ ...valid(), swiftVersion: "6.2.4" }),
  );
  assert.throws(() =>
    swiftToolsConfigSchema.parse({ ...valid(), executeManifest: true }),
  );
});

test("Swift input capture binds regular bytes without manifest evaluation and rejects omitted missing and linked inputs", async (t) => {
  const root = await fixture(t, {
    "checktrail.swift-tools.json": JSON.stringify(valid()),
    "Package.swift":
      'import Foundation\nFileManager.default.createFile(atPath: "original-manifest-marker", contents: Data())\n',
    "Sources/OriginalQuantity/Quantity.swift":
      "public func nextQuantity(_ value: Int) -> Int { value + 1 }\n",
    "Tests/OriginalQuantityTests/QuantityTests.swift":
      "// original source capture fixture\n",
  });
  const marker = path.join(root, "original-manifest-marker");
  await writeFile(
    path.join(root, "Package.swift"),
    "import Foundation\nFileManager.default.createFile(atPath: " +
      JSON.stringify(marker) +
      ", contents: Data())\n",
  );
  const source = await captureInventory(root);
  const project = discover(source).find(
    (project) => project.adapter === "swift",
  )!;
  assert.ok(project);
  const invocation = await swiftToolsInputs(source, project);
  assert.equal(invocation.inputs.length, source.files.length);
  for (const input of invocation.inputs)
    assert.equal(
      input.sha256,
      mavenHash(await readFile(path.join(root, input.path))),
    );
  await assert.rejects(access(path.join(root, "original-manifest-marker")), {
    code: "ENOENT",
  });
  const extra = "Sources/OriginalQuantity/OriginalHidden.swift";
  await writeFile(path.join(root, extra), "// original omitted source\n");
  await assert.rejects(
    swiftToolsInputs(await captureInventory(root), project),
    /every inventoried Swift source/,
  );
  await unlink(path.join(root, extra));
  const selected = "Sources/OriginalQuantity/Quantity.swift";
  await unlink(path.join(root, selected));
  await assert.rejects(swiftToolsInputs(source, project), { code: "ENOENT" });
  await symlink(path.join(root, "Package.swift"), path.join(root, selected));
  await assert.rejects(swiftToolsInputs(source, project), /symbolic links/);
});
