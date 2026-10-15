import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectFile, withinRoot } from "./inventory.js";
import { readFile } from "node:fs/promises";
import { mavenHash } from "./maven.js";
import { swiftToolsProtectedEnvironment } from "./swift-tools.js";
import {
  swiftExtensionsConfigSchema,
  swiftExtensionsInvocationSchema,
  swiftExtensionsScope,
} from "./swift-extensions-contract.js";
import type { Check, Inventory, Project } from "./types.js";
export type SwiftExtensionsMode = "build" | "xctest" | "testing" | "swiftlint";
export const swiftExtensionsPolicyFile = "checktrail.swift-extensions.json";
/** Read declared data only. Native package manifests/plugins stay unexecuted. */
export async function swiftExtensionsInputs(
  source: Inventory,
  project: Project,
) {
  const prefix = project.path === "." ? "" : project.path + "/";
  const files = source.files
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
  if (!files.includes(swiftExtensionsPolicyFile))
    throw Error("Declare complete inventoried Swift extension policy");
  const text = await readProjectFile(
    source.root,
    path.posix.join(project.path, swiftExtensionsPolicyFile),
  );
  const config = swiftExtensionsConfigSchema.parse(JSON.parse(text));
  swiftExtensionsScope(config, files);
  const inputs = await Promise.all(
    files.map(async (file) => ({
      path: file,
      sha256: mavenHash(
        await readFile(
          await withinRoot(source.root, path.posix.join(project.path, file)),
        ),
      ),
    })),
  );
  const invocation = swiftExtensionsInvocationSchema.parse({
    configSha256: mavenHash(text),
    inputs,
  });
  const serialized = JSON.stringify(invocation);
  if (Buffer.byteLength(serialized) > 96 * 1024)
    throw Error("Swift declared invocation exceeds its argument bound");
  return { config, invocation, serialized, files };
}
export async function swiftExtensionsCheck(
  source: Inventory,
  project: Project,
  mode: SwiftExtensionsMode,
): Promise<Check> {
  const check: Check = {
    id: `swift.${mode}-extensions`,
    adapter: "swift",
    project: project.path,
    kind: mode === "xctest" || mode === "testing" ? "test" : "analysis",
    scope: project.files,
    parser: "swift-extensions-json",
    commands: [],
    reason:
      "Reconcile declared local packages, build-tool output and native SDK/header/test participation.",
  };
  try {
    const { serialized, files } = await swiftExtensionsInputs(source, project);
    check.scope = files;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./swift-extensions-runner.js", import.meta.url)),
        source.root,
        serialized,
        mode,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: Object.fromEntries(
        swiftToolsProtectedEnvironment.map((k) => [k, ""]),
      ),
    });
  } catch {
    check.unavailableReason =
      "Swift extension prerequisites are missing, invalid, incomplete or outside the selected scope.";
  }
  return check;
}
