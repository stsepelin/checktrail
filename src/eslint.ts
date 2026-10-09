import { fileURLToPath } from "node:url";
import { javascriptSource } from "./javascript-source.js";
import path from "node:path";
import { javascriptConfiguration } from "./javascript-config.js";
import { eslintParticipationManifestSchema } from "./eslint-participation.js";
import { localTool } from "./local-tool.js";
import type { Check, Inventory, Project } from "./types.js";

export async function eslintCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const participation =
    (await javascriptConfiguration(source, project))?.eslint
      ?.sourceParticipation === true;
  const files = project.files.filter((file) =>
    /\.(?:[cm]?[jt]s|[jt]sx|vue)$/.test(file),
  );
  const configs = project.files.filter((file) =>
    /^eslint\.config\.(?:js|mjs|cjs)$/.test(file),
  );
  const tool = await localTool(source.root, project.path, "eslint/lib/api.js");
  const check: Check = {
    id: "javascript.eslint",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "eslint-json",
    reason:
      "Lint each inventoried JS/TS/Vue file with the project's flat config; require matching configuration and enabled rules for every file.",
    commands:
      tool && configs.length === 1
        ? [
            {
              executable: process.execPath,
              args: [
                fileURLToPath(new URL("./eslint-runner.js", import.meta.url)),
                tool,
                source.root,
                configs[0]!,
                "--processor-accounting-v1",
                ...files,
              ],
              cwd: project.path,
            },
          ]
        : [],
  };
  if (configs.length !== 1)
    check.unavailableReason =
      "Exactly one project-local eslint.config.js, .mjs or .cjs is required.";
  else if (!files.length)
    check.unavailableReason = "No supported source files were inventoried.";
  else if (!tool)
    check.unavailableReason =
      "No project-local or root-hoisted ESLint installation is available within the configured root.";
  if (participation && !check.unavailableReason) {
    const identity = async (file: string) => ({
      ...(
        await javascriptSource(source.root, path.posix.join(project.path, file))
      ).identity,
      path: file,
    });
    const manifest = eslintParticipationManifestSchema.parse({
      schemaVersion: 1,
      sourceFingerprint: source.fingerprint,
      configuration: await identity(configs[0]!),
      files: await Promise.all(files.map(identity)),
    });
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > 65536)
      throw new Error("ESLint participation manifest exceeds 64 KiB");
    check.commands[0]!.args = [
      ...check.commands[0]!.args.slice(0, 4),
      "--source-participation-v2",
      encoded,
    ];
    check.reason =
      "Lint the complete planned source with pinned native language and processor participation; require every generated block to reach its native parser.";
  }
  return check;
}
