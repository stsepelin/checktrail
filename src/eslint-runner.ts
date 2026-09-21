import path from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectFile, withinRoot } from "./inventory.js";

async function main(): Promise<void> {
  const [entry, root, config, ...files] = process.argv.slice(2);
  if (!entry || !root || !config || !files.length)
    throw new Error("Invalid ESLint runner arguments");
  const cwd = process.cwd();
  const tool = await withinRoot(root, path.relative(root, entry));
  const configPath = await withinRoot(
    root,
    path.relative(root, path.resolve(cwd, config)),
  );
  const { ESLint } = (await import(
    pathToFileURL(tool).href
  )) as typeof import("eslint");
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: configPath,
    fix: false,
    cache: false,
  });
  const evidence = [];
  let violations = false;
  for (const file of files) {
    const filePath = await withinRoot(
      root,
      path.relative(root, path.resolve(cwd, file)),
    );
    const configuration = await eslint.calculateConfigForFile(filePath);
    const activeRules = Object.values(configuration?.rules ?? {}).filter(
      (rule) => {
        const severity = Array.isArray(rule) ? rule[0] : rule;
        return (
          severity === 1 ||
          severity === 2 ||
          severity === "warn" ||
          severity === "error"
        );
      },
    ).length;
    const source = configuration
      ? await readProjectFile(root, path.relative(root, filePath))
      : undefined;
    const results =
      source === undefined
        ? []
        : await eslint.lintText(source, { filePath, warnIgnored: true });
    for (const result of results)
      violations ||= result.errorCount + result.warningCount > 0;
    evidence.push({
      path: file,
      configured: configuration !== undefined,
      activeRules,
      results: results.map(
        ({
          filePath,
          messages,
          errorCount,
          warningCount,
          fatalErrorCount,
        }) => ({
          filePath,
          messages,
          errorCount,
          warningCount,
          fatalErrorCount,
        }),
      ),
    });
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      toolVersion: ESLint.version,
      files: evidence,
    }) + "\n",
  );
  process.exitCode = violations ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "ESLint execution failed"}\n`,
  );
  process.exitCode = 2;
});
