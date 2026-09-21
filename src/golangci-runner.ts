import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { readProjectFile } from "./inventory.js";
import { hasGoSuppression } from "./go-directives.js";

const supported = z.enum([
  "errcheck",
  "govet",
  "ineffassign",
  "staticcheck",
  "unused",
]);
const configuration = z.strictObject({
  version: z.literal("2"),
  linters: z
    .strictObject({
      default: z.enum(["standard", "none"]).optional(),
      enable: z.array(supported).optional(),
      disable: z.array(supported).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      exclusions: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  run: z.record(z.string(), z.unknown()).optional(),
  issues: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  severity: z.record(z.string(), z.unknown()).optional(),
  formatters: z.record(z.string(), z.unknown()).optional(),
});
async function main(): Promise<void> {
  const [root, configFile, ...files] = process.argv.slice(2);
  if (!root || !configFile || !files.length)
    throw new Error("Invalid golangci-lint arguments");
  const version = spawnSync("golangci-lint", ["version", "--short"], {
    encoding: "utf8",
    maxBuffer: 8192,
  });
  if (
    version.error ||
    version.status !== 0 ||
    version.stderr.trim() ||
    version.stdout.trim() !== "2.13.2"
  )
    throw new Error(
      "golangci-lint integration requires installed verified version 2.13.2",
    );
  const raw = await readProjectFile(
    root,
    path.relative(root, path.resolve(configFile)),
  );
  const document = parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error("Invalid golangci-lint configuration");
  const config = configuration.parse(document.toJS({ maxAliasCount: 50 }));
  if (
    Object.keys(config.linters?.settings ?? {}).length ||
    Object.keys(config.formatters ?? {}).length ||
    Object.hasOwn(config.run ?? {}, "go") ||
    Object.hasOwn(config.run ?? {}, "build-tags")
  )
    throw new Error(
      "Custom linter settings, formatters and Go build profiles need separately verified integration",
    );
  for (const file of files)
    if (
      hasGoSuppression(
        await readProjectFile(root, path.relative(root, path.resolve(file))),
      )
    )
      throw new Error(
        "Native Go suppression directives prevent complete golangci-lint evidence",
      );
  const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-golangci-"));
  try {
    const target = path.join(temporary, "config.json");
    const native = {
      version: "2",
      run: {
        tests: true,
        "modules-download-mode": "readonly",
        "relative-path-mode": "wd",
        "issues-exit-code": 1,
        "allow-parallel-runners": true,
        "enable-build-vcs": false,
      },
      linters: {
        ...config.linters,
        settings: {},
        exclusions: {
          generated: "disable",
          presets: [],
          rules: [],
          paths: [],
          "paths-except": [],
        },
      },
      issues: {
        fix: false,
        new: false,
        "new-from-rev": "",
        "new-from-merge-base": "",
        "new-from-patch": "",
        "max-issues-per-linter": 0,
        "max-same-issues": 0,
        "uniq-by-line": false,
      },
      output: {
        formats: { json: { path: "stdout" } },
        "show-stats": false,
        "path-mode": "abs",
        "path-prefix": "",
      },
    };
    await writeFile(target, JSON.stringify(native));
    const result = spawnSync(
      "golangci-lint",
      ["run", "--config", target, "--color", "never", "./..."],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GOLANGCI_LINT_CACHE: path.join(temporary, "cache"),
        },
      },
    );
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 2;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error
      ? error.message
      : "golangci-lint execution failed") + "\n",
  );
  process.exitCode = 2;
});
