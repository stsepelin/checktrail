import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("mutation tool preparation preserves qualified native roles independently of development versions", async (t) => {
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
  const nativeAliases: Record<string, string> = {
    jest: "jest-native-mutation",
    eslint: "eslint-native-profile",
  };
  for (const name of [
    "jest",
    "eslint",
    "@types/node",
    "@modelcontextprotocol/client",
  ]) {
    const alias = nativeAliases[name];
    const declaration = alias && manifest.devDependencies[alias];
    let expected = manifest.devDependencies[name];
    if (declaration) {
      const prefix = `npm:${name}@`;
      assert.ok(declaration.startsWith(prefix));
      expected = declaration.slice(prefix.length);
      assert.match(expected, /^\d+\.\d+\.\d+$/);
      assert.equal(originalLock.packages["node_modules/" + alias].name, name);
      assert.equal(
        originalLock.packages["node_modules/" + alias].version,
        expected,
      );
      assert.equal(lock.packages["node_modules/" + name].name, name);
      assert.ok(
        !Object.keys(lock.packages).some(
          (key) =>
            key === "node_modules/" + alias ||
            key.startsWith("node_modules/" + alias + "/"),
        ),
      );
    }
    assert.equal(selected.dependencies[name], expected);
    assert.equal(lock.packages["node_modules/" + name].version, expected);
  }
  assert.equal(selected.dependencies.vitest, "5.0.5");
  assert.equal(lock.packages["node_modules/vitest"].name, "vitest");
  assert.equal(lock.packages["node_modules/vitest"].version, "5.0.5");
  assert.equal(
    manifest.devDependencies["vitest-native-mutation"],
    "npm:vitest@5.0.5",
  );
  assert.equal(
    originalLock.packages["node_modules/vitest"].version,
    manifest.devDependencies.vitest,
  );
  assert.equal(
    lock.packages["node_modules/vitest/node_modules/@vitest/mocker"].version,
    "5.0.5",
  );
  assert.ok(
    !Object.keys(lock.packages).some((key) =>
      key.includes("vitest-native-mutation"),
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

test("mutation Vitest selection rejects declaration and lock drift before projection", async () => {
  const { selectMutationToolsLock } = await import(
    new URL("../../scripts/prepare-mutation-tools.mjs", import.meta.url).href
  );
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  for (const [mutate, message] of [
    [
      (m: typeof manifest) => {
        m.devDependencies["vitest-native-mutation"] = "npm:vitest@^5.0.5";
      },
      /Native mutation Vitest role must retain its qualified exact pin/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies["vitest-native-mutation"] =
          "npm:vitest@5.1.0";
      },
      /Native mutation Vitest lock root differs/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vitest-native-mutation"].name = "other";
      },
      /Native mutation Vitest alias target differs/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vitest-native-mutation"].version = "5.1.0";
      },
      /Native mutation Vitest alias version differs/,
    ],
    [
      (m: typeof manifest) => {
        m.devDependencies.vitest = "^5.1.0";
      },
      /Development Vitest declaration must be exactly pinned/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies.vitest = "9.9.9";
      },
      /Development Vitest lock root differs/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/vitest"].version = "9.9.9";
      },
      /Development Vitest lock version differs/,
    ],
  ] as const) {
    const m = structuredClone(manifest),
      l = structuredClone(lock);
    mutate(m, l);
    assert.throws(() => selectMutationToolsLock(m, l), {
      code: "ERR_ASSERTION",
      message,
    });
  }
});

test("mutation Vitest projection retains alias-scoped dependencies despite colliding development versions", async () => {
  const { selectMutationToolsLock } = await import(
    new URL("../../scripts/prepare-mutation-tools.mjs", import.meta.url).href
  );
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  manifest.devDependencies.vitest = "99.0.0";
  lock.packages[""].devDependencies.vitest = "99.0.0";
  lock.packages["node_modules/vitest"].version = "99.0.0";
  const alias = "node_modules/vitest-native-mutation";
  lock.packages[alias].dependencies["synthetic-leaf"] = "1.0.0";
  const entry = {
    version: "1.0.0",
    resolved:
      "https://registry.npmjs.org/synthetic-leaf/-/synthetic-leaf-1.0.0.tgz",
    integrity: "sha512-AAAA",
  };
  lock.packages[alias + "/node_modules/synthetic-leaf"] = entry;
  lock.packages["node_modules/vitest/node_modules/synthetic-leaf"] = {
    ...entry,
    version: "99.0.0",
  };
  const before = JSON.stringify(lock);
  const selected = selectMutationToolsLock(manifest, lock);
  assert.equal(selected.manifest.dependencies.vitest, "5.0.5");
  assert.equal(
    selected.lock.packages["node_modules/vitest/node_modules/synthetic-leaf"]
      .version,
    "1.0.0",
  );
  assert.equal(
    selected.lock.packages["node_modules/vitest/node_modules/@vitest/mocker"]
      .version,
    "5.0.5",
  );
  assert.equal(JSON.stringify(lock), before);
});

test("mutation Vitest role refuses a missing alias even when development matches the native pin", async () => {
  const { selectMutationToolsLock } = await import(
    new URL("../../scripts/prepare-mutation-tools.mjs", import.meta.url).href
  );
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  manifest.devDependencies.vitest = "5.0.5";
  lock.packages[""].devDependencies.vitest = "5.0.5";
  lock.packages["node_modules/vitest"].version = "5.0.5";
  delete manifest.devDependencies["vitest-native-mutation"];
  assert.throws(() => selectMutationToolsLock(manifest, lock), {
    code: "ERR_ASSERTION",
    message: /Native mutation Vitest role/,
  });
});
