import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { javascriptSource } from "./javascript-source.js";
import { readProjectFile, withinRoot } from "./inventory.js";
import { eslintParticipationManifestSchema } from "./eslint-participation.js";
import { eslintParticipationPrerequisites } from "./eslint-participation-prerequisites.js";
import { observeESLintParticipation } from "./eslint-participation-runtime.js";

async function main(): Promise<void> {
  const [entry, root, config, ...files] = process.argv.slice(2);
  if (!entry || !root || !config)
    throw new Error("Invalid ESLint runner arguments");
  const participation = files[0] === "--source-participation-v2";
  let manifest;
  let arrayEntry: string | undefined;
  if (participation) {
    if (files.length !== 2 || Buffer.byteLength(files[1]!) > 65536)
      throw new Error("Invalid participation manifest transport");
    manifest = eslintParticipationManifestSchema.parse(JSON.parse(files[1]!));
    if (
      manifest.configuration.path !== config ||
      new Set(manifest.files.map((f) => f.path)).size !== manifest.files.length
    )
      throw new Error("Invalid participation manifest identities");
    files.splice(0, files.length, ...manifest.files.map((f) => f.path));
    try {
      const ready = await eslintParticipationPrerequisites(root, entry);
      if (!ready.available) {
        process.stdout.write(
          JSON.stringify({
            unavailable: "eslint-participation",
            reason: ready.reason,
          }) + "\n",
        );
        process.exitCode = 3;
        return;
      }
      arrayEntry = ready.arrayEntry;
    } catch {
      process.stdout.write(
        JSON.stringify({
          unavailable: "eslint-participation",
          reason: "missing-runtime",
        }) + "\n",
      );
      process.exitCode = 3;
      return;
    }
  } else if (files[0] === "--processor-accounting-v1") files.shift();
  if (!files.length) throw new Error("Invalid ESLint runner arguments");
  const cwd = process.cwd();
  const tool = await withinRoot(root, path.relative(root, entry));
  const configPath = await withinRoot(
    root,
    path.relative(root, path.resolve(cwd, config)),
  );
  const observed = async (file: string) => ({
    ...(await javascriptSource(root, path.relative(root, file))).identity,
    path: file,
  });
  const matches = (
    a: { bytes: number; sha256: string },
    b: { bytes: number; sha256: string },
  ) => a.bytes === b.bytes && a.sha256 === b.sha256;
  if (manifest && !matches(await observed(configPath), manifest.configuration))
    throw new Error("Planned ESLint configuration changed");
  const { ESLint } = (await import(
    pathToFileURL(tool).href
  )) as typeof import("eslint");
  const prototype = arrayEntry
    ? (
        createRequire(tool)(arrayEntry) as {
          ConfigArray: { prototype: object };
        }
      ).ConfigArray.prototype
    : undefined;
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: configPath,
    fix: false,
    cache: false,
  });
  const evidence = [];
  let violations = false;
  for (const [index, file] of files.entries()) {
    const filePath = await withinRoot(
      root,
      path.relative(root, path.resolve(cwd, file)),
    );
    const sourceIdentity = manifest ? await observed(filePath) : undefined;
    if (manifest && !matches(sourceIdentity!, manifest.files[index]!))
      throw new Error("Planned ESLint source changed");
    const observation = prototype
      ? observeESLintParticipation(prototype, filePath)
      : undefined;
    try {
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
        processorUsed: configuration?.processor !== undefined,
        activeRules,
        ...(observation
          ? { source: sourceIdentity, participation: observation.trace }
          : {}),
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
    } finally {
      observation?.restore();
    }
  }
  if (manifest) {
    const ready = await eslintParticipationPrerequisites(root, entry);
    if (!ready.available || ready.arrayEntry !== arrayEntry)
      throw new Error("Pinned native runtime changed during lint");
    if (!matches(await observed(configPath), manifest.configuration))
      throw new Error("Planned ESLint configuration changed during lint");
    for (const [i, file] of files.entries()) {
      const resolved = await withinRoot(
        root,
        path.relative(root, path.resolve(cwd, file)),
      );
      if (!matches(await observed(resolved), manifest.files[i]!))
        throw new Error("Planned ESLint source changed during lint");
    }
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: participation ? 2 : 1,
      toolVersion: ESLint.version,
      ...(manifest
        ? {
            sourceFingerprint: manifest.sourceFingerprint,
            configuration: manifest.configuration,
          }
        : {}),
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
