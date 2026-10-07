import { cp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { cppToolsConfigSchema, cppCmake } from "../src/cpp-tools.js";
export const cppToolsNative = {
  skip:
    process.env.CHECKTRAIL_CPP_TOOLS_NATIVE === "1" &&
    (
      spawnSync("clang", ["--version"], { encoding: "utf8" }).stdout || ""
    ).startsWith("Alpine clang version 22.1.3\n")
      ? false
      : "Pinned C/C++ tools profile not selected",
  timeout: 120000,
};
export async function cppToolsFixture(
  t: TestContext,
  checks = ["cpp.build", "cpp.ctest", "cpp.clang-format", "cpp.clang-tidy"],
) {
  const root = await fixture(t, {});
  await cp(
    fileURLToPath(new URL("../../examples/cpp-tools/", import.meta.url)),
    root,
    { recursive: true },
  );
  const config = cppToolsConfigSchema.parse(
    JSON.parse(
      await readFile(path.join(root, "checktrail.cpp-tools.json"), "utf8"),
    ),
  );
  await writeFile(path.join(root, "CMakeLists.txt"), cppCmake(config));
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({ schemaVersion: 1, projects: [{ path: ".", checks }] }),
  );
  return { root, config };
}
