import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { externalDigestSchema, externalPathSchema } from "./external-schema.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { mavenHash } from "./maven.js";
import { cppMd5 } from "./cpp-native.js";
import { cppRequire, cppProtectedEnvironment } from "./cpp-tools.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsScope,
  cppExtensionsCmake,
} from "./cpp-extensions-contract.js";
import type { Check, Inventory, Project } from "./types.js";
export const cppExtensionsPolicyFile = "checktrail.cpp-extensions.json";
export const cppExtensionsInvocationSchema = z.strictObject({
  configSha256: externalDigestSchema,
  inputs: z
    .array(
      z.strictObject({
        path: externalPathSchema,
        sha256: externalDigestSchema,
        md5: z.string().regex(/^[a-f0-9]{32}$/),
      }),
    )
    .min(1)
    .max(4096),
});
/** Capture the complete declared cohort without running project CMake or native tools. */
export async function cppExtensionsInputs(source: Inventory, project: Project) {
  const prefix = project.path === "." ? "" : project.path + "/";
  const files = source.files
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
  cppRequire(
    files.includes(cppExtensionsPolicyFile),
    "Declare complete CMake extension policy",
  );
  const policy = await readFile(
    await withinRoot(
      source.root,
      path.posix.join(project.path, cppExtensionsPolicyFile),
    ),
  );
  const config = cppExtensionsConfigSchema.parse(
    JSON.parse(policy.toString("utf8")),
  );
  cppExtensionsScope(config, files);
  for (const [file, text] of Object.entries(cppExtensionsCmake(config)))
    cppRequire(
      (await readProjectFile(
        source.root,
        path.posix.join(project.path, file),
      )) === text,
      "CMake manifest differs from selected finite declaration",
    );
  const inputs = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(
        await withinRoot(source.root, path.posix.join(project.path, file)),
      );
      return { path: file, sha256: mavenHash(bytes), md5: cppMd5(bytes) };
    }),
  );
  const invocation = cppExtensionsInvocationSchema.parse({
    configSha256: mavenHash(policy),
    inputs,
  });
  const serialized = JSON.stringify(invocation);
  cppRequire(
    Buffer.byteLength(serialized) <= 96 * 1024,
    "CMake extension invocation argument bound",
  );
  return { config, invocation, serialized, files };
}

export type CppExtensionsMode =
  "build" | "ctest" | "clang-format" | "clang-tidy";
export async function cppExtensionsCheck(
  source: Inventory,
  project: Project,
  mode: CppExtensionsMode,
): Promise<Check> {
  const check: Check = {
    id: `cpp.${mode}-extensions`,
    adapter: "cpp",
    project: project.path,
    kind:
      mode === "ctest"
        ? "test"
        : mode === "clang-format"
          ? "format"
          : "analysis",
    scope: project.files,
    parser: "cpp-extensions-json",
    commands: [],
    reason:
      "Reconcile local CMake interfaces, generated headers, linked artifacts and selected native SDK consumption.",
  };
  try {
    const { serialized, files } = await cppExtensionsInputs(source, project);
    check.scope = files;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./cpp-extensions-runner.js", import.meta.url)),
        source.root,
        serialized,
        mode,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(cppProtectedEnvironment.map((k) => [k, ""])),
        PATH: process.env.PATH ?? "",
        CCC_OVERRIDE_OPTIONS: "#",
      },
    });
  } catch {
    check.unavailableReason =
      "C/C++ extension prerequisites are missing, invalid, incomplete or outside the selected scope.";
  }
  return check;
}
