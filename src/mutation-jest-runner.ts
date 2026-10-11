import path from "node:path";
import { createRequire } from "node:module";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withinRoot } from "./inventory.js";
import { mutationBoundedBytes } from "./mutation-native-copy.js";
async function main() {
  const [entry, inputRoot, ...selected] = process.argv.slice(2);
  if (!entry || !inputRoot || !selected.length || selected.length > 16)
    throw new Error("Selected mutation Jest arguments differ");
  const root = await withinRoot(inputRoot, "."),
    tool = await withinRoot(root, path.relative(inputRoot, entry));
  const metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await mutationBoundedBytes(
        root,
        path.relative(
          root,
          path.resolve(path.dirname(tool), "../package.json"),
        ),
        65536,
      ),
    ),
  );
  if (metadata.name !== "jest" || metadata.version !== "30.5.2")
    throw new Error("Selected mutation Jest pin differs");
  const files = await Promise.all(
    selected.map((file) => withinRoot(root, file)),
  );
  if (new Set(files).size !== files.length)
    throw new Error("Selected mutation files repeated");
  const { runCLI } = createRequire(import.meta.url)(
    tool,
  ) as typeof import("jest");
  const hooksPath = path.join(root, ".checktrail-mutation-jest-hooks.jsonl");
  await writeFile(hooksPath, "", { flag: "wx", mode: 0o600 });
  process.env.CHECKTRAIL_MUTATION_JEST_HOOKS = hooksPath;
  process.env.CHECKTRAIL_MUTATION_JEST_ENTRY = tool;
  const { results } = await runCLI(
    {
      $0: "checktrail",
      _: files,
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
      testLocationInResults: true,
      testEnvironment: fileURLToPath(
        new URL("./mutation-jest-environment.js", import.meta.url),
      ),
    },
    [root],
  );
  const hooks = new TextDecoder("utf-8", { fatal: true })
    .decode(
      await mutationBoundedBytes(root, path.relative(root, hooksPath), 1048576),
    )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  await rm(hooksPath);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      format: "checktrail-mutation-jest-1",
      version: metadata.version,
      selectedFiles: files,
      native: { ...results, coverageMap: undefined },
      hooks,
    }) + "\n",
  );
  process.exitCode = results.success ? 0 : 1;
}
main().catch(() => {
  process.stderr.write(
    "Selected mutation Jest collection is unavailable or incomplete\n",
  );
  process.exitCode = 2;
});
