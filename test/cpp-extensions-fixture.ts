import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { cppFormatStyle } from "../src/cpp-native.js";
import {
  cppExtensionsPolicyFile,
  type CppExtensionsMode,
} from "../src/cpp-extensions.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsCmake,
} from "../src/cpp-extensions-contract.js";
export const cppExtensionsDeclaredConfig = () =>
  cppExtensionsConfigSchema.parse({
    schemaVersion: 1,
    profile: "declared-local-cmake-transitive-sdk-v1",
    project: "OriginalGraph",
    clangVersion: "22.1.3",
    cmakeVersion: "4.2.3",
    makeVersion: "4.4.1",
    binutilsVersion: "2.45.1",
    platform: "aarch64-alpine-linux-musl",
    sysroot: "/",
    standardLibrary: "libstdc++",
    directories: [".", "lib", "lib/core"],
    headers: [
      "lib/core/include/original_core.h",
      "lib/include/original_bridge.hpp",
    ],
    generatedHeaders: [
      {
        directory: "lib/core",
        template: "lib/core/include/original_step.h.in",
        output: "generated/original_step.h",
        values: { CT_STEP: 1 },
      },
    ],
    targets: [
      {
        name: "original_consumer",
        directory: ".",
        type: "executable",
        sources: ["main.cpp"],
        publicIncludes: [],
        privateIncludes: [],
        publicLinks: [],
        privateLinks: ["original_bridge"],
      },
      {
        name: "original_bridge",
        directory: "lib",
        type: "shared",
        sources: ["lib/bridge.cpp"],
        publicIncludes: ["lib/include"],
        privateIncludes: [],
        publicLinks: ["original_core"],
        privateLinks: [],
      },
      {
        name: "original_core",
        directory: "lib/core",
        type: "static",
        sources: ["lib/core/core.c"],
        publicIncludes: ["lib/core/include", "lib/core/generated"],
        privateIncludes: [],
        publicLinks: [],
        privateLinks: [],
      },
    ],
    tests: [{ name: "original_boundary", target: "original_consumer" }],
    tidyRules: ["clang-analyzer-core.DivideZero"],
    sdk: [
      {
        path: "usr/include/original_synthetic.h",
        resolved: "usr/include/original_synthetic.h",
        bytes: 1,
        sha256: "0".repeat(64),
      },
    ],
  });
export const cppExtensionsOriginalInputs = () => {
  const c = cppExtensionsDeclaredConfig();
  return {
    ...cppExtensionsCmake(c),
    "main.cpp":
      '#include "original_bridge.hpp"\n#include <vector>\nint main(){std::vector<int> values{2,4};for(int value:values){if(original_bridge(value)!=value+1)return 1;}return 0;}\n',
    "lib/bridge.cpp":
      '#include "original_bridge.hpp"\nextern "C" {\n#include "original_core.h"\n}\nint original_bridge(int value){return original_core(value);}\n',
    "lib/include/original_bridge.hpp": "int original_bridge(int value);\n",
    "lib/core/core.c":
      '#include "original_core.h"\n#include "original_step.h"\nint original_core(int value){return value+ORIGINAL_STEP;}\n',
    "lib/core/include/original_core.h": "int original_core(int value);\n",
    "lib/core/include/original_step.h.in": "#define ORIGINAL_STEP @CT_STEP@\n",
  };
};

export const cppExtensionsNative = {
  skip:
    process.env.CHECKTRAIL_CPP_EXTENSIONS_NATIVE === "1" &&
    !!process.env.CHECKTRAIL_CPP_EXTENSIONS_SDK
      ? false
      : "Pinned C/C++ extension native profile not selected",
  timeout: 120000,
};
export async function cppExtensionsFixture(
  t: TestContext,
  modes: CppExtensionsMode[] = ["build", "ctest", "clang-format", "clang-tidy"],
) {
  const config = cppExtensionsDeclaredConfig();
  assert.ok(
    process.env.CHECKTRAIL_CPP_EXTENSIONS_SDK,
    "Native SDK manifest required",
  );
  config.sdk = JSON.parse(
    await readFile(process.env.CHECKTRAIL_CPP_EXTENSIONS_SDK, "utf8"),
  ).pins;
  config.tests.push({
    name: "original_adjacent_boundary",
    target: "original_consumer",
  });
  const files: Record<string, string> = {
    ...cppExtensionsOriginalInputs(),
    ...cppExtensionsCmake(config),
  };
  for (const [file, source] of Object.entries(files))
    if (/\.(?:c|cpp|h|hpp)$/.test(file)) {
      const formatted = spawnSync(
        "clang-format",
        [`--style=${cppFormatStyle}`],
        { input: source, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
      );
      assert.equal(formatted.error, undefined);
      assert.equal(formatted.status, 0, formatted.stderr);
      assert.ok(formatted.stdout.trim());
      files[file] = formatted.stdout;
    }
  const root = await fixture(t, {
    ...files,
    [cppExtensionsPolicyFile]: JSON.stringify(config),
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: ".", checks: modes.map((m) => `cpp.${m}-extensions`) },
      ],
    }),
  });
  return { root, config };
}
export async function cppExtensionsWriteConfig(
  root: string,
  config: ReturnType<typeof cppExtensionsDeclaredConfig>,
) {
  await writeFile(
    path.join(root, cppExtensionsPolicyFile),
    JSON.stringify(config),
  );
  for (const [file, text] of Object.entries(cppExtensionsCmake(config)))
    await writeFile(path.join(root, file), text);
}
