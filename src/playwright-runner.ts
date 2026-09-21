import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { FullConfig, FullProject } from "@playwright/test/reporter";
import { withinRoot } from "./inventory.js";

interface NativeConfig {
  config: FullConfig;
  projects: { project: FullProject }[];
  webServers: unknown[];
  plugins: unknown[];
  captureGitInfo?: { commit: boolean; diff: boolean };
}

async function main(): Promise<void> {
  const [entry, root] = process.argv.slice(2);
  if (!entry || !root) throw new Error("Invalid Playwright runner arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const require = createRequire(tool);
  const metadata = require(tool) as { name?: string; version?: string };
  if (metadata.name !== "playwright" || metadata.version !== "1.63.0")
    throw new Error(
      "Playwright native configuration integration requires verified version 1.63.0",
    );
  const { configLoader } = require("playwright/lib/common") as {
    configLoader: {
      loadConfigFromFile(
        file: string,
        overrides: Record<string, unknown>,
      ): Promise<NativeConfig>;
    };
  };
  const { testRunner } = require("playwright/lib/runner") as {
    testRunner: {
      runAllTestsWithConfig(
        config: NativeConfig,
        options: Record<string, unknown>,
      ): Promise<string>;
    };
  };
  const output = await mkdtemp(path.join(tmpdir(), "checktrail-playwright-"));
  try {
    const config = await configLoader.loadConfigFromFile(process.cwd(), {
      forbidOnly: true,
      failOnFlakyTests: true,
      maxFailures: 0,
      updateSnapshots: "none",
      updateSourceMethod: "patch",
      ignoreSnapshots: false,
      shard: null,
      outputDir: output,
      workers: 1,
      quiet: true,
      reporter: [
        [fileURLToPath(new URL("./playwright-reporter.js", import.meta.url))],
      ],
    });
    if (config.webServers.length || config.plugins.length)
      throw new Error(
        "Playwright webServer and private runner plugins require separately supported execution profiles",
      );
    if (
      new Set(config.projects.map(({ project }) => project.name)).size !==
      config.projects.length
    )
      throw new Error(
        "Playwright project names must be unique for evidence accounting",
      );
    config.captureGitInfo = { commit: false, diff: false };
    config.config.grep = /.*/;
    config.config.grepInvert = null;
    for (const { project } of config.projects) {
      project.grep = /.*/;
      project.grepInvert = null;
    }
    const status = await testRunner.runAllTestsWithConfig(config, {
      listMode: false,
      passWithNoTests: false,
      lastFailed: false,
    });
    process.exitCode = status === "passed" ? 0 : 1;
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Playwright execution failed"}\n`,
  );
  process.exitCode = 2;
});
