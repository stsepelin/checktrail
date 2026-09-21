import path from "node:path";
import { pathToFileURL } from "node:url";
import { withinRoot } from "./inventory.js";

async function main(): Promise<void> {
  const [entry, root, ...files] = process.argv.slice(2);
  if (!entry || !root || !files.length)
    throw new Error("Invalid Vitest runner arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
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
  const ctx = await startVitest(
    filters,
    {
      root: process.cwd(),
      run: true,
      watch: false,
      update: "none",
      allowOnly: false,
      passWithNoTests: false,
      dangerouslyIgnoreUnhandledErrors: false,
      onUnhandledError: () => true,
      cache: false,
      fsModuleCache: false,
      reporters: [new JsonReporter({ stdout: true, outputFile: "" })],
    },
    undefined,
    { packageInstaller: new InstalledOnly() },
  );
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
  await ctx.close();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Vitest execution failed"}\n`,
  );
  process.exitCode = 2;
});
