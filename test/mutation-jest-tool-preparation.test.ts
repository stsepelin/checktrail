import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

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
      /Native mutation Jest role/,
    ],
    [
      (m: typeof manifest) => {
        m.devDependencies.jest = "^30.5.2";
      },
      /Development Jest declaration/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies.jest = "99.0.0";
      },
      /Development Jest lock root/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest"].version = "99.0.0";
      },
      /Development Jest lock version/,
    ],
    [
      (m: typeof manifest) => {
        m.devDependencies["jest-native-mutation"] = "npm:jest@^30.5.2";
      },
      /Native mutation Jest role/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages[""].devDependencies["jest-native-mutation"] =
          "npm:jest@30.5.3";
      },
      /Native mutation Jest lock root/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest-native-mutation"].name = "other";
      },
      /Native mutation Jest alias target/,
    ],
    [
      (_m: typeof manifest, l: typeof lock) => {
        l.packages["node_modules/jest-native-mutation"].version = "30.5.3";
      },
      /Native mutation Jest alias version/,
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

test("mutation Jest role refuses a missing alias even when development matches the native pin", async () => {
  const { select, manifest, lock } = await roleInputs();
  delete manifest.devDependencies["jest-native-mutation"];
  assert.throws(() => select(manifest, lock), {
    code: "ERR_ASSERTION",
    message: /Native mutation Jest role/,
  });
});
