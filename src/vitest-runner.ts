import path from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectFile, withinRoot } from "./inventory.js";
import { vitestMajor } from "./vitest-version.js";
import type { CliOptions, Vitest, VitestOptions } from "vitest/node";

type StartVitest4 = (
  mode: "test",
  filters: string[],
  options: Omit<CliOptions, "experimental"> & {
    experimental: { fsModuleCache: false };
  },
  overrides: undefined,
  runtime: VitestOptions,
) => Promise<Vitest>;

async function main(): Promise<void> {
  const [entry, inputRoot, ...files] = process.argv.slice(2);
  if (!entry || !inputRoot || !files.length)
    throw new Error("Invalid Vitest runner arguments");
  const root = await withinRoot(inputRoot, ".");
  const tool = await withinRoot(root, path.relative(inputRoot, entry));
  const major = vitestMajor(
    JSON.parse(
      await readProjectFile(
        root,
        path.relative(
          root,
          path.resolve(path.dirname(tool), "../package.json"),
        ),
      ),
    ),
  );
  const { startVitest, JsonReporter, VitestPackageInstaller } = (await import(
    pathToFileURL(tool).href
  )) as typeof import("vitest/node");
  class InstalledOnly extends VitestPackageInstaller {
    override async ensureInstalled(
      dependency: string,
      cwd: string,
    ): Promise<boolean> {
      if (!this.isPackageExists(dependency, { paths: [cwd] }))
        throw new Error(
          `Install required Vitest dependency locally: ${dependency}`,
        );
      return true;
    }
  }
  const filters = [];
  for (const file of files)
    filters.push(
      await withinRoot(root, path.relative(root, path.resolve(file))),
    );
  const options = {
    root: process.cwd(),
    run: true,
    watch: false,
    update: "none" as const,
    allowOnly: false,
    passWithNoTests: false,
    dangerouslyIgnoreUnhandledErrors: false,
    onUnhandledError: () => true,
    cache: false as const,
    reporters: [new JsonReporter({ stdout: true, outputFile: "" })],
  };
  const runtime = { packageInstaller: new InstalledOnly() };
  const ctx =
    major === 4
      ? await (startVitest as unknown as StartVitest4)(
          "test",
          filters,
          { ...options, experimental: { fsModuleCache: false } },
          undefined,
          runtime,
        )
      : await startVitest(
          filters,
          { ...options, fsModuleCache: false },
          undefined,
          runtime,
        );
  try {
    const errors = ctx.state.getUnhandledErrors();
    if (errors.length) {
      process.exitCode = 1;
      for (const error of errors) {
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? String(error.message)
            : String(error);
        process.stderr.write(`Unhandled Vitest error: ${message}\n`);
      }
    }
  } finally {
    await ctx.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Vitest execution failed"}\n`,
  );
  process.exitCode = 2;
});
