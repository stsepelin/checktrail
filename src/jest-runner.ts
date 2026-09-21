import path from "node:path";
import { createRequire } from "node:module";
import { withinRoot } from "./inventory.js";

async function main(): Promise<void> {
  const [entry, root, ...files] = process.argv.slice(2);
  if (!entry || !root || !files.length)
    throw new Error("Invalid Jest runner arguments");
  const tool = await withinRoot(root, path.relative(root, entry));
  const { runCLI } = createRequire(import.meta.url)(
    tool,
  ) as typeof import("jest");
  const paths: string[] = [];
  for (const file of files)
    paths.push(await withinRoot(root, path.relative(root, path.resolve(file))));
  const { results } = await runCLI(
    {
      $0: "repo-verifier",
      _: paths,
      ci: true,
      runInBand: true,
      runTestsByPath: true,
      watch: false,
      watchAll: false,
      updateSnapshot: false,
      cache: false,
      collectTests: false,
      listTests: false,
      passWithNoTests: false,
      onlyChanged: false,
      onlyFailures: false,
      findRelatedTests: false,
      testNamePattern: "",
      testResultsProcessor: "",
      filter: "",
      bail: 0,
      json: false,
      useStderr: true,
      reporters: ["default"],
      runner: "jest-runner",
      testRunner: "jest-circus/runner",
    },
    [process.cwd()],
  );
  const evidence = { ...results, coverageMap: undefined };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  process.exitCode = results.success ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Jest execution failed"}\n`,
  );
  process.exitCode = 2;
});
