import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("mutation tool preparation binds current runner declarations and frozen native roles in a complete exact locked pair", async (t) => {
  const files = Object.fromEntries(
    await Promise.all(
      [
        "package.json",
        "package-lock.json",
        "scripts/prepare-mutation-tools.mjs",
        "scripts/prepare-javascript-tools.mjs",
      ].map(async (file) => [
        file,
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ]),
    ),
  );
  const root = await fixture(t, files);
  const result = spawnSync(
    process.execPath,
    ["scripts/prepare-mutation-tools.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rangeResolutionPerformed, false);
  const directory = path.join(root, ".checktrail/mutation-javascript-tools");
  assert.deepEqual((await readdir(directory)).sort(), [
    "package-lock.json",
    "package.json",
  ]);
  const selected = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(path.join(directory, "package-lock.json"), "utf8"),
  );
  const manifest = JSON.parse(files["package.json"]!);
  const originalLock = JSON.parse(files["package-lock.json"]!);
  for (const name of [
    "vitest",
    "jest",
    "@types/node",
    "@modelcontextprotocol/client",
  ]) {
    assert.equal(selected.dependencies[name], manifest.devDependencies[name]);
    assert.equal(
      lock.packages["node_modules/" + name].version,
      manifest.devDependencies[name],
    );
  }
  const alias = "eslint-native-profile";
  const nativeEntry = originalLock.packages["node_modules/" + alias];
  assert.equal(
    manifest.devDependencies[alias],
    "npm:eslint@" + nativeEntry.version,
  );
  assert.equal(
    originalLock.packages[""].devDependencies[alias],
    manifest.devDependencies[alias],
  );
  assert.equal(nativeEntry.name, "eslint");
  assert.equal(selected.dependencies.eslint, nativeEntry.version);
  assert.equal(
    lock.packages["node_modules/eslint"].version,
    nativeEntry.version,
  );
  assert.equal(lock.packages["node_modules/eslint"].name, "eslint");
  assert.equal(lock.packages["node_modules/" + alias], undefined);
  const config = "@eslint/config-array";
  assert.equal(selected.dependencies[config], manifest.devDependencies[config]);
  assert.equal(
    lock.packages["node_modules/" + config].version,
    manifest.devDependencies[config],
  );
  const parser = "@typescript-eslint/parser";
  const expected =
    originalLock.packages["node_modules/typescript-eslint"].dependencies[
      parser
    ];
  assert.equal(selected.dependencies[parser], expected);
  assert.equal(lock.packages["node_modules/" + parser].version, expected);
  assert.deepEqual(lock.packages[""].dependencies, selected.dependencies);
  for (const file of ["package.json", "package-lock.json"]) {
    assert.equal(await readFile(path.join(root, file), "utf8"), files[file]);
  }
});
