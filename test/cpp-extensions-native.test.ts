import assert from "node:assert/strict";
import { test } from "node:test";
import { cppExtensionsDependencies } from "../src/cpp-extensions-sdk.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsSdkPath,
  cppExtensionsScope,
} from "../src/cpp-extensions-contract.js";
import {
  cppExtensionsLinkClosure,
  cppExtensionsDwarf,
  cppExtensionsSupportedVersion,
  cppExtensionsLinkRuntime,
  cppExtensionsIncludePaths,
} from "../src/cpp-extensions-native.js";
import {
  cppExtensionsDeclaredConfig,
  cppExtensionsOriginalInputs,
} from "./cpp-extensions-fixture.js";

test("C/C++ native dependency records retain actual linker group multiplicity and require every emitted phony target", () => {
  const raw =
    "original_consumer: \\\n  /usr/lib/Scrt1.o \\\n  CMakeFiles/original_consumer.dir/main.cpp.o \\\n  lib/liboriginal_bridge.so \\\n  /usr/lib/libgcc_s.so.1 \\\n  /usr/lib/libgcc_s.so.1\n\n/usr/lib/Scrt1.o:\n\nCMakeFiles/original_consumer.dir/main.cpp.o:\n\nlib/liboriginal_bridge.so:\n\n/usr/lib/libgcc_s.so.1:\n\n/usr/lib/libgcc_s.so.1:\n";
  const native = cppExtensionsDependencies(raw);
  assert.equal(native.output, "original_consumer");
  assert.deepEqual(native.files, [
    "/usr/lib/Scrt1.o",
    "CMakeFiles/original_consumer.dir/main.cpp.o",
    "lib/liboriginal_bridge.so",
    "/usr/lib/libgcc_s.so.1",
    "/usr/lib/libgcc_s.so.1",
  ]);
  assert.deepEqual(native.phony, native.files);
  for (const changed of [
    raw.replace("\n\n/usr/lib/Scrt1.o:", ""),
    raw + "\n/usr/lib/Scrt1.o:\n",
    raw.replace("\n\n/usr/lib/Scrt1.o:", "\n\n/usr/lib/Scrt1.oAdjacent:"),
    raw.replace("/usr/lib/Scrt1.o ", "/usr/lib/Scrt1.o$(echo secret) "),
  ])
    assert.throws(() => cppExtensionsDependencies(changed));
  const compiler = cppExtensionsDependencies(
    "CMakeFiles/original_consumer.dir/main.cpp.o: \\\n  /project/main.cpp \\\n  /usr/include/c++/15.2.0/vector\n",
  );
  assert.deepEqual(compiler.files, [
    "/project/main.cpp",
    "/usr/include/c++/15.2.0/vector",
  ]);
  assert.deepEqual(compiler.phony, []);
});

test("C/C++ SDK names preserve native C++ plus signs and exact musl aliases without adjacent-root or unpinned-target admission", () => {
  const config = cppExtensionsDeclaredConfig(),
    files = Object.keys(cppExtensionsOriginalInputs());
  config.sdk.push(
    {
      path: "usr/lib/libstdc++.so",
      resolved: "usr/lib/libstdc++.so.6.0.34",
      bytes: 1,
      sha256: "1".repeat(64),
    },
    {
      path: "usr/lib/libstdc++.so.6.0.34",
      resolved: "usr/lib/libstdc++.so.6.0.34",
      bytes: 1,
      sha256: "1".repeat(64),
    },
  );
  cppExtensionsConfigSchema.parse(config);
  cppExtensionsScope(config, files);
  assert.equal(cppExtensionsSdkPath("lib/ld-musl-aarch64.so.1"), true);
  for (const name of [
    "lib/ld-musl-aarch64.so.1Adjacent",
    "usr/libAdjacent/libstdc++.so",
    "usr/includeAdjacent/vector",
  ])
    assert.equal(cppExtensionsSdkPath(name), false, name);
  const missing = structuredClone(config);
  missing.sdk.pop();
  assert.throws(() => cppExtensionsScope(missing, files), /SDK pin outside/);
  const changed = structuredClone(config);
  changed.sdk.at(-1)!.sha256 = "2".repeat(64);
  assert.throws(() => cppExtensionsScope(changed, files), /SDK pin outside/);
});

test("C/C++ public interfaces propagate compile and link requirements while private shared links stop at their owner", () => {
  const c = cppExtensionsDeclaredConfig();
  assert.deepEqual(cppExtensionsLinkClosure(c, "original_consumer"), [
    "original_bridge",
    "original_core",
  ]);
  c.targets[1]!.publicLinks = [];
  c.targets[1]!.privateLinks = ["original_core"];
  assert.deepEqual(cppExtensionsLinkClosure(c, "original_consumer"), [
    "original_bridge",
  ]);
  assert.deepEqual(
    cppExtensionsIncludePaths(c, "original_consumer", "/project", "/build"),
    ["/project/lib/include"],
  );
  assert.deepEqual(cppExtensionsLinkClosure(c, "original_bridge"), [
    "original_core",
  ]);
  assert.deepEqual(
    cppExtensionsIncludePaths(c, "original_bridge", "/project", "/build"),
    [
      "/project/lib/include",
      "/project/lib/core/include",
      "/build/lib/core/generated",
    ],
  );
});

test("C/C++ pinned GNU assembler checksum byte order and exact runtime groups distinguish real hashes and adjacent versions", () => {
  const raw =
    'original.o:\tfile format elf64-littleaarch64\n.debug_line contents:\ndebug_line[0x00000000]\nformat: DWARF32\nversion: 5\ninclude_directories[  0] = "/original"\nfile_names[  0]:\n name: "source.cpp"\n dir_index: 0\n md5_checksum: 00112233445566778899aabbccddeeff\n';
  assert.equal(
    cppExtensionsDwarf(raw).get("/original/source.cpp"),
    "ffeeddccbbaa99887766554433221100",
  );
  assert.equal(
    cppExtensionsDwarf(raw.replace(/\n md5_checksum: [a-f0-9]+/, "")).get(
      "/original/source.cpp",
    ),
    "",
  );
  assert.ok(
    cppExtensionsSupportedVersion(
      "as",
      "GNU assembler (GNU Binutils) 2.45.1\nThis assembler was configured for a target of `aarch64-alpine-linux-musl'.\n",
    ),
  );
  assert.equal(
    cppExtensionsSupportedVersion(
      "as",
      "GNU assembler (GNU Binutils) 2.45.2\nThis assembler was configured for a target of `aarch64-alpine-linux-musl'.\n",
    ),
    false,
  );
  assert.equal(
    cppExtensionsSupportedVersion(
      "as",
      "GNU assembler (GNU Binutils) 2.45.1\nThis assembler was configured for a target of `x86_64-alpine-linux-musl'.\n",
    ),
    false,
  );
  const cpp = cppExtensionsLinkRuntime("CXX", true),
    c = cppExtensionsLinkRuntime("C", false),
    trace = cppExtensionsLinkRuntime("CXX", true, true);
  assert.equal(cpp.prefix.length, 3);
  assert.equal(c.prefix.length, 2);
  assert.ok(cpp.suffix.includes("/usr/lib/libstdc++.so"));
  assert.equal(c.suffix.includes("/usr/lib/libstdc++.so"), false);
  assert.equal(
    cpp.suffix.filter((f) => f === "/usr/lib/libgcc_s.so").length,
    6,
  );
  assert.equal(
    trace.suffix.filter((f) => f === "/usr/lib/libgcc_s.so").length,
    2,
  );
});
