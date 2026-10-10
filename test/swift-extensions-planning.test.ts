import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { inventory } from "../src/inventory.js";
import { discover } from "../src/adapters.js";
import {
  swiftExtensionsCheck,
  swiftExtensionsPolicyFile,
} from "../src/swift-extensions.js";
import {
  swiftExtensionsOriginalInputs,
  swiftExtensionsDeclaredConfig,
} from "./swift-extensions-fixture.js";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
const source = async (root: string) => {
  const data = await inventory(root),
    project = discover(data).find(
      (p) => p.path === "." && p.adapter === "swift",
    )!;
  assert.ok(project);
  return { data, project };
};
test("Swift extension planning captures local-package files while manifest execution stays absent", async (t) => {
  const config = swiftExtensionsDeclaredConfig(),
    root = await fixture(t, {
      ...swiftExtensionsOriginalInputs,
      [swiftExtensionsPolicyFile]: JSON.stringify(config),
    });
  const marker = path.join(root, "unexpected-manifest-execution"),
    manifest = path.join(root, "Package.swift");
  const text = await readFile(manifest, "utf8");
  await writeFile(
    manifest,
    text.replace(
      "import PackageDescription",
      "import PackageDescription\nimport Foundation\nFileManager.default.createFile(atPath: " +
        JSON.stringify(marker) +
        ", contents: Data())",
    ),
  );
  const { data, project } = await source(root);
  assert.ok(!project.files.includes("Packages/Producer/Package.swift"));
  for (const mode of ["build", "xctest", "testing", "swiftlint"] as const) {
    const check = await swiftExtensionsCheck(data, project, mode);
    assert.equal(check.unavailableReason, undefined);
    assert.equal(check.commands.length, 1);
    assert.ok(check.scope.includes("Packages/Producer/Package.swift"));
    assert.ok(
      check.scope.includes(
        "Packages/Producer/Sources/OriginalProducer/Producer.swift",
      ),
    );
    await assert.rejects(access(marker));
  }
});
test("Swift extension planning carries a policy digest instead of oversized SDK policy arguments", async (t) => {
  const config = swiftExtensionsDeclaredConfig();
  config.sdk = Array.from({ length: 2000 }, (_, i) => ({
    root: "swift" as const,
    path: `linux/OriginalSDK${i}.swiftmodule`,
    bytes: 1,
    sha256: "0".repeat(64),
  }));
  const policy = JSON.stringify(config);
  assert.ok(Buffer.byteLength(policy) > 128 * 1024);
  const root = await fixture(t, {
    ...swiftExtensionsOriginalInputs,
    [swiftExtensionsPolicyFile]: policy,
  });
  const asset = path.join(root, "OriginalUnused.bin"),
    bytes = Buffer.from([0, 255, 128, 0, 64]);
  await writeFile(asset, bytes);
  const { data, project } = await source(root),
    check = await swiftExtensionsCheck(data, project, "build");
  assert.equal(check.unavailableReason, undefined);
  const text = check.commands[0]!.args[2]!;
  assert.ok(Buffer.byteLength(text) < 96 * 1024);
  assert.ok(!text.includes("OriginalSDK"));
  const invocation = JSON.parse(text);
  assert.equal(invocation.configSha256, mavenHash(policy));
  assert.equal(
    invocation.inputs.find(
      (i: { path: string; sha256: string }) => i.path === "OriginalUnused.bin",
    ).sha256,
    mavenHash(bytes),
  );
});
test("Swift extension planning rejects policy trust missing local source and conflicting graph declarations before commands", async (t) => {
  const config = swiftExtensionsDeclaredConfig();
  for (const edit of [
    (c: typeof config) => ({ ...c, trusted: true }),
    (c: typeof config) => {
      c.packages[0]!.dependencies[0]!.path = "Packages/Adjacent";
      return c;
    },
    (c: typeof config) => {
      c.packages[1]!.targets[0]!.sources.push(
        "Sources/OriginalProducer/Missing.swift",
      );
      return c;
    },
  ]) {
    const root = await fixture(t, {
      ...swiftExtensionsOriginalInputs,
      [swiftExtensionsPolicyFile]: JSON.stringify(
        edit(structuredClone(config)),
      ),
    });
    const { data, project } = await source(root),
      check = await swiftExtensionsCheck(data, project, "build");
    assert.equal(check.commands.length, 0);
    assert.ok(check.unavailableReason);
  }
});
