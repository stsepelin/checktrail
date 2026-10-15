import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cppExtensionsConfigSchema,
  cppExtensionsScope,
  cppExtensionsCmake,
  cppExtensionsIncludes,
} from "../src/cpp-extensions-contract.js";
import {
  cppExtensionsDeclaredConfig,
  cppExtensionsOriginalInputs,
} from "./cpp-extensions-fixture.js";
test("CMake extension declarations retain mixed target kinds local manifests and transitive public includes", () => {
  const c = cppExtensionsDeclaredConfig(),
    files = Object.keys(cppExtensionsOriginalInputs());
  cppExtensionsScope(c, files);
  assert.deepEqual(Object.keys(cppExtensionsCmake(c)), [
    "CMakeLists.txt",
    "lib/CMakeLists.txt",
    "lib/core/CMakeLists.txt",
  ]);
  assert.deepEqual(cppExtensionsIncludes(c, "original_consumer"), [
    "lib/include",
    "lib/core/include",
    "lib/core/generated",
  ]);
  assert.ok(
    cppExtensionsCmake(c)["lib/CMakeLists.txt"]!.includes(
      "target_link_libraries(original_bridge PUBLIC original_core)",
    ),
  );
  assert.ok(
    cppExtensionsCmake(c)["lib/core/CMakeLists.txt"]!.includes(
      '"${PROJECT_BINARY_DIR}/lib/core/generated"',
    ),
  );
  const privateOnly = structuredClone(c);
  privateOnly.targets[1]!.publicLinks = [];
  privateOnly.targets[1]!.privateLinks = ["original_core"];
  cppExtensionsScope(privateOnly, files);
  assert.deepEqual(cppExtensionsIncludes(privateOnly, "original_consumer"), [
    "lib/include",
  ]);
  assert.deepEqual(cppExtensionsIncludes(privateOnly, "original_bridge"), [
    "lib/include",
    "lib/core/include",
    "lib/core/generated",
  ]);
});
test("CMake extension declarations reject command syntax escapes external manifests and incomplete graph families", () => {
  const c = cppExtensionsDeclaredConfig(),
    files = Object.keys(cppExtensionsOriginalInputs());
  for (const path of [
    "main.cpp;execute_process(COMMAND curl)",
    "main file.cpp",
    "../escape.cpp",
    "lib/../../escape.cpp",
    "lib/$ENV{TOKEN}.cpp",
    'lib/quoted".cpp',
    "lib/adjacent\\file.cpp",
  ]) {
    const changed = structuredClone(c);
    changed.targets[0]!.sources = [path];
    assert.equal(
      cppExtensionsConfigSchema.safeParse(changed).success,
      false,
      path,
    );
  }
  for (const edit of [
    (x: typeof c) => {
      x.targets[2]!.publicLinks = ["original_bridge"];
    },
    (x: typeof c) => {
      x.targets[1]!.publicLinks = ["original_core_adjacent"];
    },
    (x: typeof c) => {
      x.targets[0]!.privateLinks = [];
    },
    (x: typeof c) => {
      x.targets[2]!.sources.push("lib/bridge.cpp");
    },
    (x: typeof c) => {
      x.directories = [".", "lib/core"];
    },
    (x: typeof c) => {
      x.targets[1]!.publicIncludes.push("lib/include");
    },
    (x: typeof c) => {
      x.generatedHeaders[0]!.output = "elsewhere/generated.h";
    },
    (x: typeof c) => {
      x.sdk[0]!.path = "usr/includeAdjacent/secret.h";
    },
    (x: typeof c) => {
      x.sdk[0]!.resolved = "usr/includeAdjacent/secret.h";
    },
    (x: typeof c) => {
      x.sdk[0]!.resolved = "usr/include/unpinned.h";
    },
    (x: typeof c) => {
      x.tests[0]!.target = "original_bridge";
    },
  ]) {
    const changed = structuredClone(c);
    edit(changed);
    assert.throws(() => cppExtensionsScope(changed, files));
  }
  for (const extra of [
    "lib/private.cmake",
    "lib/extra/CMakeLists.txt",
    "lib/adjacent.cpp",
    "lib/include/adjacent.hpp",
  ])
    assert.throws(() => cppExtensionsScope(c, [...files, extra]), extra);
  assert.equal(
    cppExtensionsConfigSchema.safeParse({ ...c, trusted: true }).success,
    false,
  );
});
