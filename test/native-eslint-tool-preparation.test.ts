import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { eslintParticipationVersions } from "../src/eslint-participation-pins.js";

const { selectMutationToolsLock } = await import(
  new URL("../../scripts/prepare-mutation-tools.mjs", import.meta.url).href
);

test("mutation preparation composes frozen ESLint and Vitest roles despite both development versions advancing", async () => {
  const [manifest, lock] = await Promise.all(
    ["package.json", "package-lock.json"].map(async (file) =>
      JSON.parse(
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ),
    ),
  );
  const original = selectMutationToolsLock(manifest, lock);
  const changedManifest = structuredClone(manifest);
  const changedLock = structuredClone(lock);
  for (const name of ["eslint", "vitest"]) {
    changedManifest.devDependencies[name] = "99.0.0";
    changedLock.packages[""].devDependencies[name] = "99.0.0";
    changedLock.packages["node_modules/" + name].version = "99.0.0";
  }
  const before = JSON.stringify([changedManifest, changedLock]);
  const selected = selectMutationToolsLock(changedManifest, changedLock);
  const alias = "eslint-native-profile";
  const native = lock.packages["node_modules/" + alias];
  assert.equal(manifest.devDependencies[alias], "npm:eslint@" + native.version);
  assert.equal(
    lock.packages[""].devDependencies[alias],
    manifest.devDependencies[alias],
  );
  assert.equal(native.name, "eslint");
  assert.equal(native.version, eslintParticipationVersions.eslint);
  assert.equal(selected.manifest.dependencies.eslint, native.version);
  assert.equal(selected.lock.packages["node_modules/eslint"].name, "eslint");
  assert.equal(
    selected.lock.packages["node_modules/eslint"].version,
    native.version,
  );
  assert.ok(
    !Object.keys(selected.lock.packages).some(
      (key) =>
        key === "node_modules/" + alias ||
        key.startsWith("node_modules/" + alias + "/"),
    ),
  );
  const config = "@eslint/config-array";
  assert.equal(
    manifest.devDependencies[config],
    eslintParticipationVersions[config],
  );
  assert.equal(
    selected.manifest.dependencies[config],
    manifest.devDependencies[config],
  );
  assert.equal(
    selected.lock.packages["node_modules/" + config].version,
    manifest.devDependencies[config],
  );
  assert.equal(selected.manifest.dependencies.vitest, "5.0.5");
  assert.deepEqual(selected, original);
  assert.equal(JSON.stringify([changedManifest, changedLock]), before);
});
