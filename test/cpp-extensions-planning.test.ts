import assert from "node:assert/strict";
import path from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { inventory } from "../src/inventory.js";
import { discover } from "../src/adapters.js";
import {
  cppExtensionsInputs,
  cppExtensionsPolicyFile,
} from "../src/cpp-extensions.js";
import {
  cppExtensionsDeclaredConfig,
  cppExtensionsOriginalInputs,
} from "./cpp-extensions-fixture.js";
import { fixture } from "./helpers.js";
import { mavenHash } from "../src/maven.js";
import { createPlan, validate } from "../src/engine.js";
import { cppExtensionsFreshness } from "../src/cpp-extensions-freshness.js";
async function capture(root: string) {
  const source = await inventory(root);
  const project = discover(source).find(
    (p) => p.adapter === "cpp" && p.path === ".",
  );
  assert.ok(project);
  return cppExtensionsInputs(source, project);
}
test("CMake extension planning retains local source and binary bytes with bounded digest-only SDK policy arguments", async (t) => {
  const config = cppExtensionsDeclaredConfig();
  config.sdk = Array.from({ length: 2000 }, (_, i) => ({
    path: `usr/include/original_sdk_${i}.h`,
    resolved: `usr/include/original_sdk_${i}.h`,
    bytes: 1,
    sha256: "0".repeat(64),
  }));
  const policy = JSON.stringify(config);
  assert.ok(Buffer.byteLength(policy) > 128 * 1024);
  const root = await fixture(t, {
    ...cppExtensionsOriginalInputs(),
    [cppExtensionsPolicyFile]: policy,
  });
  const bytes = Buffer.from([0, 255, 128, 0]);
  await writeFile(path.join(root, "OriginalUnused.bin"), bytes);
  const result = await capture(root);
  assert.ok(result.files.includes("lib/core/core.c"));
  assert.ok(Buffer.byteLength(result.serialized) < 96 * 1024);
  assert.ok(!result.serialized.includes("original_sdk"));
  assert.equal(result.invocation.configSha256, mavenHash(policy));
  assert.equal(
    result.invocation.inputs.find((p) => p.path === "OriginalUnused.bin")!
      .sha256,
    mavenHash(bytes),
  );
});
test("CMake extension planning rejects undeclared executable directives without reaching their side effects", async (t) => {
  const root = await fixture(t, {
    ...cppExtensionsOriginalInputs(),
    [cppExtensionsPolicyFile]: JSON.stringify(cppExtensionsDeclaredConfig()),
  });
  const file = path.join(root, "lib/CMakeLists.txt"),
    before = await readFile(file, "utf8"),
    marker = path.join(root, "unexpected-cmake-execution");
  try {
    await writeFile(
      file,
      before + `\nfile(WRITE "${marker}" "original synthetic canary")\n`,
    );
    await assert.rejects(capture(root), /manifest differs/);
    await assert.rejects(access(marker));
  } finally {
    await writeFile(file, before);
  }
  assert.equal((await capture(root)).config.project, "OriginalGraph");
});

test("CMake extension shared-engine planning selects the declared root graph and cannot grant execution trust", async (t) => {
  const ids = [
    "cpp.build-extensions",
    "cpp.ctest-extensions",
    "cpp.clang-format-extensions",
    "cpp.clang-tidy-extensions",
  ];
  const root = await fixture(t, {
    ...cppExtensionsOriginalInputs(),
    [cppExtensionsPolicyFile]: JSON.stringify(cppExtensionsDeclaredConfig()),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ids }],
    }),
  });
  const { plan, source } = await createPlan(root);
  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ids,
  );
  for (const check of plan.checks) {
    assert.equal(check.unavailableReason, undefined);
    assert.equal(check.parser, "cpp-extensions-json");
    assert.equal(check.commands.length, 1);
    assert.ok(check.scope.includes("lib/core/core.c"));
    assert.deepEqual(
      cppExtensionsFreshness(check, source.root).config,
      cppExtensionsDeclaredConfig(),
    );
  }
  await assert.rejects(
    validate(root, { trusted: false }),
    /requires operator trust/,
  );
  const file = path.join(root, "lib/core/core.c"),
    original = await readFile(file, "utf8");
  try {
    await writeFile(
      file,
      original + "// original synthetic stale receipt canary\n",
    );
    assert.throws(
      () => cppExtensionsFreshness(plan.checks[0]!, source.root),
      /source bytes differ/,
    );
  } finally {
    await writeFile(file, original);
  }
  assert.equal(
    cppExtensionsFreshness(plan.checks[0]!, source.root).config.project,
    "OriginalGraph",
  );
});
