import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("mutation tool preparation keeps the qualified Jest role separate from development declarations", async (t) => {
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
    "eslint",
    "@types/node",
    "@modelcontextprotocol/client",
  ]) {
    assert.equal(selected.dependencies[name], manifest.devDependencies[name]);
    assert.equal(
      lock.packages["node_modules/" + name].version,
      manifest.devDependencies[name],
    );
  }
  assert.equal(selected.dependencies.jest, "30.5.2");
  assert.equal(lock.packages["node_modules/jest"].name, "jest");
  assert.equal(lock.packages["node_modules/jest"].version, "30.5.2");
  assert.equal(
    manifest.devDependencies["jest-native-mutation"],
    "npm:jest@30.5.2",
  );
  assert.ok(
    !Object.keys(lock.packages).some((key) =>
      key.includes("jest-native-mutation"),
    ),
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

async function roleInputs() {
  const module = await import(
    new URL("../../scripts/prepare-mutation-tools.mjs", import.meta.url).href
  );
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  return { select: module.selectMutationToolsLock, manifest, lock };
}
test("mutation Jest role rejects declaration and lock drift before projection", async () => {
  const { select, manifest, lock } = await roleInputs();
  for (const [mutate, message] of [
    [
      (m: typeof manifest) => {
        delete m.devDependencies["jest-native-mutation"];
      },
      /Native mutation jest role/,
    ],
    [
      (m: typeof manifest) => {
        m.devDependencies.jest = "^30.5.2";
      },
      /Development jest declaration/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies.jest = "99.0.0";
      },
      /Development jest lock root/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest"].version = "99.0.0";
      },
      /Development jest lock version/,
    ],
    [
      (m: typeof manifest) => {
        m.devDependencies["jest-native-mutation"] = "npm:jest@^30.5.2";
      },
      /Native mutation jest role/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies["jest-native-mutation"] =
          "npm:jest@30.5.3";
      },
      /Native mutation jest lock root/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest-native-mutation"].name = "other";
      },
      /Native mutation jest alias target/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest-native-mutation"].version = "30.5.3";
      },
      /Native mutation jest alias version/,
    ],
  ] as const) {
    const m = structuredClone(manifest),
      l = structuredClone(lock);
    mutate(m, l);
    assert.throws(() => select(m, l), { code: "ERR_ASSERTION", message });
  }
});
test("mutation Jest role preserves its native closure across coherent future development versions and nested collisions", async () => {
  const { select, manifest, lock } = await roleInputs();
  manifest.devDependencies.jest = "99.0.0";
  lock.packages[""].devDependencies.jest = "99.0.0";
  lock.packages["node_modules/jest"].version = "99.0.0";
  const alias = "node_modules/jest-native-mutation";
  lock.packages[alias].dependencies["synthetic-leaf"] = "1.0.0";
  const entry = {
    version: "1.0.0",
    resolved:
      "https://registry.npmjs.org/synthetic-leaf/-/synthetic-leaf-1.0.0.tgz",
    integrity: "sha512-AAAA",
  };
  lock.packages[alias + "/node_modules/synthetic-leaf"] = entry;
  lock.packages["node_modules/jest/node_modules/synthetic-leaf"] = {
    ...entry,
    version: "99.0.0",
  };
  const before = JSON.stringify(lock),
    selected = select(manifest, lock);
  assert.equal(selected.manifest.dependencies.jest, "30.5.2");
  assert.equal(selected.lock.packages["node_modules/jest"].version, "30.5.2");
  assert.equal(
    selected.lock.packages["node_modules/jest/node_modules/synthetic-leaf"]
      .version,
    "1.0.0",
  );
  assert.equal(JSON.stringify(lock), before);
});
test("mutation roles compose with the separate Vitest alias without accepting an unqualified legacy fallback", async () => {
  const { select, manifest, lock } = await roleInputs();
  const vitest = structuredClone(lock.packages["node_modules/vitest"]);
  manifest.devDependencies.vitest = "99.0.0";
  lock.packages[""].devDependencies.vitest = "99.0.0";
  lock.packages["node_modules/vitest"].version = "99.0.0";
  assert.throws(() => select(manifest, lock), {
    code: "ERR_ASSERTION",
    message: /Native mutation vitest requires its qualified alias/,
  });
  manifest.devDependencies["vitest-native-mutation"] = "npm:vitest@5.0.5";
  lock.packages[""].devDependencies["vitest-native-mutation"] =
    "npm:vitest@5.0.5";
  lock.packages["node_modules/vitest-native-mutation"] = {
    ...vitest,
    name: "vitest",
  };
  const selected = select(manifest, lock);
  assert.equal(selected.manifest.dependencies.vitest, "5.0.5");
  assert.equal(selected.manifest.dependencies.jest, "30.5.2");
  assert.equal(selected.lock.packages["node_modules/vitest"].version, "5.0.5");
  assert.equal(selected.lock.packages["node_modules/jest"].version, "30.5.2");
});
