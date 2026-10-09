import path from "node:path";
import { fileURLToPath } from "node:url";
import { javascriptConfiguration } from "./javascript-config.js";
import { javascriptSource } from "./javascript-source.js";
import { readProjectFile } from "./inventory.js";
import { nodeLoaderManifestSchema } from "./node-loader-contract.js";
import type { Check, Inventory, Project } from "./types.js";
export async function nodeTestCheck(
  source: Inventory,
  project: Project,
  explicit: boolean,
): Promise<Check> {
  const manifest: unknown = JSON.parse(
    await readProjectFile(
      source.root,
      path.posix.join(project.path, "package.json"),
    ),
  );
  const scripts =
    typeof manifest === "object" && manifest !== null && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  const script =
    typeof scripts === "object" && scripts !== null && "test" in scripts
      ? scripts.test
      : undefined;
  const profile = (await javascriptConfiguration(source, project))?.nodeTest;
  const files = project.files.filter((file) =>
    (profile ? /\.(test|spec)\.[cm]?[jt]s$/ : /\.(test|spec)\.[cm]?js$/).test(
      file,
    ),
  );
  const check: Check = {
    id: "javascript.node-test",
    adapter: project.adapter,
    project: project.path,
    kind: "test",
    parser: "node-events",
    scope: files,
    reason:
      "Run the selected native Node tests with file-level and global case accounting.",
    commands: [
      {
        executable: process.execPath,
        args: [
          "--test",
          `--test-reporter=${new URL("./node-reporter.js", import.meta.url).href}`,
          ...files.map((file) => `./${file}`),
        ],
        cwd: project.path,
      },
    ],
  };
  if (!explicit && script !== "node --test")
    check.unavailableReason =
      "Node runner is not explicitly selected. Set scripts.test to node --test or select javascript.node-test in policy after verifying the runner.";
  else if (!files.length)
    check.unavailableReason = profile
      ? "No declared-loader JS/TS native test files were discovered."
      : "No .test.js/.spec.js (or .mjs/.cjs) files were discovered.";
  if (profile && !check.unavailableReason) {
    check.parser = "node-loader-events";
    if (
      new Set(profile.loaders.map((loader) => loader.path)).size !==
      profile.loaders.length
    )
      throw new Error("Duplicate Node loader path");
    const loaders = [...profile.loaders].sort(
      (a, b) => Number(a.kind === "import") - Number(b.kind === "import"),
    );
    for (const loader of loaders) {
      if (!project.files.includes(loader.path)) {
        check.unavailableReason =
          "Declared Node loader is absent from project inventory";
        return check;
      }
      if (
        (
          await javascriptSource(
            source.root,
            path.posix.join(project.path, loader.path),
          )
        ).identity.sha256 !== loader.sha256
      ) {
        check.unavailableReason =
          "Declared Node loader bytes differ from their selected hash";
        return check;
      }
    }
    const selected = nodeLoaderManifestSchema.parse({
      schemaVersion: 1,
      sourceFingerprint: source.fingerprint,
      runtime: process.versions.node,
      loaders,
      files: await Promise.all(
        files.map(async (file) => ({
          ...(
            await javascriptSource(
              source.root,
              path.posix.join(project.path, file),
            )
          ).identity,
          path: file,
        })),
      ),
    });
    const encoded = JSON.stringify(selected);
    if (Buffer.byteLength(encoded) > 65536)
      throw new Error("Node loader manifest exceeds 64 KiB");
    check.commands = [
      {
        executable: process.execPath,
        args: [
          fileURLToPath(new URL("./node-loader-runner.js", import.meta.url)),
          source.root,
          encoded,
        ],
        cwd: project.path,
      },
    ];
    check.reason =
      "Run every inventoried JS/TS native test with declared import/require hooks, verified source bytes and complete native case accounting.";
  }
  return check;
}
