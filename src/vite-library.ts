import path from "node:path";
import { fileURLToPath } from "node:url";
import { javascriptConfiguration } from "./javascript-config.js";
import { javascriptSource } from "./javascript-source.js";
import { localTool } from "./local-tool.js";
import { viteLibraryManifestSchema } from "./vite-library-contract.js";
import type { Check, Inventory, Project } from "./types.js";
export async function viteLibraryCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "javascript.vite-library",
    adapter: project.adapter,
    project: project.path,
    kind: "analysis",
    parser: "vite-library-json",
    scope: [],
    commands: [],
    reason:
      "Build declared local library source in native Vite ESM/CJS formats and check every downstream consumer against fresh native TypeScript declarations.",
  };
  const profile = (await javascriptConfiguration(source, project))?.library;
  if (!profile) {
    check.unavailableReason =
      "A declared library profile in checktrail.javascript.json is required";
    return check;
  }
  const files = project.files.filter(
    (file) =>
      file.startsWith(profile.sourceDirectory + "/") &&
      /\.[cm]?[jt]s$/.test(file),
  );
  check.scope = [...files, ...profile.consumers];
  if (
    !files.includes(profile.entry) ||
    !profile.consumers.every((file) => project.files.includes(file)) ||
    profile.consumers.some((file) => files.includes(file)) ||
    new Set(profile.consumers).size !== profile.consumers.length
  ) {
    check.unavailableReason =
      "Library entry and distinct consumers must belong to their inventoried source selection";
    return check;
  }
  const entry = await localTool(
    source.root,
    project.path,
    "vite/dist/node/index.js",
  );
  const compiler = await localTool(
    source.root,
    project.path,
    "typescript/lib/typescript.js",
  );
  if (!entry || !compiler) {
    check.unavailableReason =
      "Native Vite and TypeScript must be installed inside the configured root";
    return check;
  }
  const identity = async (file: string) => ({
    ...(
      await javascriptSource(source.root, path.posix.join(project.path, file))
    ).identity,
    path: file,
  });
  const selected = viteLibraryManifestSchema.parse({
    schemaVersion: 1,
    sourceFingerprint: source.fingerprint,
    profile,
    sources: await Promise.all(files.map(identity)),
    consumers: await Promise.all(profile.consumers.map(identity)),
  });
  const encoded = JSON.stringify(selected);
  if (Buffer.byteLength(encoded) > 65536)
    throw new Error("Vite library manifest exceeds 64 KiB");
  check.commands = [
    {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("./vite-library-runner.js", import.meta.url)),
        entry,
        compiler,
        source.root,
        encoded,
      ],
      cwd: project.path,
      temporaryDirectory: true,
    },
  ];
  return check;
}
