import assert from "node:assert/strict";
import { lstat, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eslintParticipationVersions } from "../src/eslint-participation-pins.js";
import { copyInstalledPackages } from "./tool-fixture.js";

export const eslintConfig =
  "export default [{rules: {'no-debugger': 'error'}}];\n";
export const eslintPolicy = (project = ".") =>
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: project, checks: ["javascript.eslint"] }],
  });

export const copyESLint = (root: string): Promise<void> =>
  copyInstalledPackages(root, ["eslint"]);

/** Copy the frozen native profile, independently of the repository's development linter. */
export async function copyESLintParticipation(
  root: string,
  selectedModules?: string,
): Promise<void> {
  const modules =
    selectedModules ??
    fileURLToPath(new URL("../../node_modules/", import.meta.url));
  const alias = "eslint-native-profile";
  let aliased = true;
  try {
    const stat = await lstat(path.join(modules, alias));
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Native ESLint alias must be a directory",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    aliased = false;
  }
  const sourceName = aliased ? alias : "eslint";
  const metadata = JSON.parse(
    await readFile(path.join(modules, sourceName, "package.json"), "utf8"),
  );
  assert.equal(
    metadata.name,
    "eslint",
    "Native ESLint installed package name differs",
  );
  assert.equal(
    metadata.version,
    eslintParticipationVersions.eslint,
    "Native ESLint installed version differs from frozen profile",
  );
  const configName = "@eslint/config-array";
  const configVersion = eslintParticipationVersions[configName];
  const configMetadata = JSON.parse(
    await readFile(path.join(modules, configName, "package.json"), "utf8"),
  );
  assert.equal(
    configMetadata.name,
    configName,
    "Native config-array installed package name differs",
  );
  assert.equal(
    configMetadata.version,
    configVersion,
    "Native config-array installed version differs",
  );
  let lock: { packages: Record<string, { version?: string }> } | undefined;
  if (aliased) {
    const owner = path.dirname(modules);
    const [manifest, source] = await Promise.all(
      ["package.json", "package-lock.json"].map(async (file) =>
        JSON.parse(await readFile(path.join(owner, file), "utf8")),
      ),
    );
    const declaration = "npm:eslint@" + eslintParticipationVersions.eslint;
    assert.equal(
      manifest.devDependencies?.[alias],
      declaration,
      "Native ESLint alias declaration differs from frozen profile",
    );
    assert.equal(
      source.lockfileVersion,
      3,
      "Native ESLint alias requires lockfile v3",
    );
    assert.equal(
      source.packages[""]?.devDependencies?.[alias],
      declaration,
      "Native ESLint alias lock root differs",
    );
    assert.equal(
      source.packages["node_modules/" + alias]?.name,
      "eslint",
      "Native ESLint alias locked package name differs",
    );
    assert.equal(
      source.packages["node_modules/" + alias]?.version,
      metadata.version,
      "Native ESLint alias locked version differs",
    );
    assert.equal(
      manifest.devDependencies?.[configName],
      configVersion,
      "Native config-array declaration differs",
    );
    assert.equal(
      source.packages[""].devDependencies?.[configName],
      configVersion,
      "Native config-array lock root differs",
    );
    assert.equal(
      source.packages["node_modules/" + configName]?.version,
      configVersion,
      "Native config-array locked version differs",
    );
    lock = source;
  }
  await assert.rejects(lstat(path.join(root, "node_modules/eslint")), {
    code: "ENOENT",
  });
  await copyInstalledPackages(
    root,
    [sourceName, configName],
    modules,
    ({ relative, version }) => {
      const location = relative.split(path.sep).join("/");
      if (lock)
        assert.equal(
          version,
          lock.packages["node_modules/" + location]?.version,
          "Native ESLint copied dependency differs from lock",
        );
      if (
        location === configName ||
        location.endsWith("/node_modules/" + configName)
      )
        assert.equal(
          version,
          configVersion,
          "Native config-array copied resolution differs",
        );
    },
  );
  if (aliased)
    await rename(
      path.join(root, "node_modules", alias),
      path.join(root, "node_modules/eslint"),
    );
}
