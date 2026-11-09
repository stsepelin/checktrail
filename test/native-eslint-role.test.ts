import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { copyESLintParticipation } from "./eslint-helpers.js";
import { eslintParticipationVersions } from "../src/eslint-participation-pins.js";

const alias = "eslint-native-profile";
const aliasKey = "node_modules/" + alias;
const version = eslintParticipationVersions.eslint;
const configName = "@eslint/config-array";
const configVersion = eslintParticipationVersions[configName];
const { selectJavaScriptToolsLock } = await import(
  new URL("../../scripts/prepare-javascript-tools.mjs", import.meta.url).href
);
const inputs = async () =>
  Promise.all(
    ["package.json", "package-lock.json"].map(async (file) =>
      JSON.parse(
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ),
    ),
  );

test("native ESLint projection stays identical when the separate development linter pin advances", async () => {
  const [manifest, lock] = await inputs();
  const selected = selectJavaScriptToolsLock(manifest, lock);
  assert.equal(selected.manifest.dependencies.eslint, version);
  assert.equal(selected.lock.packages["node_modules/eslint"].name, "eslint");
  assert.equal(selected.lock.packages["node_modules/eslint"].version, version);
  assert.equal(selected.lock.packages[aliasKey], undefined);
  assert.equal(selected.sources["node_modules/eslint"], aliasKey);
  const changedManifest = structuredClone(manifest),
    changedLock = structuredClone(lock);
  changedManifest.devDependencies.eslint = "999.0.0";
  changedLock.packages[""].devDependencies.eslint = "999.0.0";
  changedLock.packages["node_modules/eslint"].version = "999.0.0";
  changedLock.packages["node_modules/eslint"].dependencies[configName] =
    "99.0.0";
  changedLock.packages["node_modules/eslint/node_modules/" + configName] = {
    ...changedLock.packages["node_modules/" + configName],
    version: "99.0.0",
  };
  changedLock.packages["node_modules/eslint/node_modules/ajv"] = {
    ...changedLock.packages[aliasKey + "/node_modules/ajv"],
    version: "99.0.0",
  };
  // This is a metadata selection near miss, not an execution or qualification of that version.
  assert.deepEqual(
    selectJavaScriptToolsLock(changedManifest, changedLock),
    selected,
  );
});

test("native ESLint projection rejects alias declaration and lock drift while preserving exact nested namespace boundaries", async () => {
  const [manifest, lock] = await inputs();
  for (const declaration of [
    "npm:eslint@^" + version,
    "npm:other@" + version,
    version,
    "",
  ]) {
    const changed = structuredClone(manifest);
    changed.devDependencies[alias] = declaration;
    assert.throws(
      () => selectJavaScriptToolsLock(changed, lock),
      /alias must exactly pin/,
    );
  }
  for (const change of [
    (entry: typeof lock) => {
      entry.packages[""].devDependencies[alias] = "npm:eslint@0.0.0";
    },
    (entry: typeof lock) => {
      entry.packages[aliasKey].name = "other";
    },
    (entry: typeof lock) => {
      entry.packages[aliasKey].version = "0.0.0";
    },
    (entry: typeof lock) => {
      delete entry.packages[aliasKey];
    },
  ]) {
    const changed = structuredClone(lock);
    change(changed);
    assert.throws(
      () => selectJavaScriptToolsLock(manifest, changed),
      /Native ESLint alias/,
    );
  }
  for (const change of [
    (entry: typeof manifest) => {
      entry.devDependencies[configName] = "^" + configVersion;
    },
    (entry: typeof manifest) => {
      delete entry.devDependencies[configName];
    },
  ]) {
    const changed = structuredClone(manifest);
    change(changed);
    assert.throws(
      () => selectJavaScriptToolsLock(changed, lock),
      /exactly pinned/,
    );
  }
  for (const change of [
    (entry: typeof lock) => {
      entry.packages[""].devDependencies[configName] = "0.0.0";
    },
    (entry: typeof lock) => {
      entry.packages["node_modules/" + configName].version = "0.0.0";
    },
    (entry: typeof lock) => {
      entry.packages[aliasKey + "/node_modules/" + configName] = {
        ...entry.packages["node_modules/" + configName],
        version: "99.0.0",
      };
    },
  ]) {
    const changed = structuredClone(lock);
    change(changed);
    assert.throws(
      () => selectJavaScriptToolsLock(manifest, changed),
      /config-array|Tool lock/,
    );
  }
  const nested = structuredClone(lock);
  const leaf = {
    version: "1.0.0",
    resolved:
      "https://registry.npmjs.org/original-role-leaf/-/original-role-leaf-1.0.0.tgz",
    integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
  };
  nested.packages[aliasKey].dependencies["original-role-leaf"] = "1.0.0";
  nested.packages[aliasKey + "/node_modules/original-role-leaf"] = leaf;
  nested.packages[aliasKey + "-near/node_modules/original-role-leaf"] = {
    ...leaf,
    version: "2.0.0",
  };
  const selected = selectJavaScriptToolsLock(manifest, nested);
  assert.deepEqual(
    selected.lock.packages[
      "node_modules/eslint/node_modules/original-role-leaf"
    ],
    leaf,
  );
  assert.ok(
    !Object.keys(selected.lock.packages).some((key) => key.includes(alias)),
  );
  assert.equal(
    selected.sources["node_modules/eslint/node_modules/original-role-leaf"],
    aliasKey + "/node_modules/original-role-leaf",
  );
  assert.equal(
    Object.values(selected.lock.packages).filter(
      (entry: unknown) =>
        (entry as { resolved?: string }).resolved === leaf.resolved,
    ).length,
    1,
  );
});

const files = () => ({
  "package.json": JSON.stringify({
    devDependencies: {
      [alias]: "npm:eslint@" + version,
      eslint: "99.0.0",
      [configName]: configVersion,
    },
  }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {
        devDependencies: {
          [alias]: "npm:eslint@" + version,
          [configName]: configVersion,
        },
      },
      [aliasKey]: { name: "eslint", version },
      ["node_modules/" + configName]: { version: configVersion },
      [aliasKey + "/node_modules/native-leaf"]: { version: "1.0.0" },
    },
  }),
  [aliasKey + "/package.json"]: JSON.stringify({
    name: "eslint",
    version,
    dependencies: { [configName]: "^" + configVersion, "native-leaf": "1.0.0" },
  }),
  ["node_modules/" + configName + "/package.json"]: JSON.stringify({
    name: configName,
    version: configVersion,
  }),
  [aliasKey + "/node_modules/native-leaf/package.json"]: JSON.stringify({
    name: "native-leaf",
    version: "1.0.0",
  }),
  [aliasKey + "/node_modules/native-leaf/marker.js"]:
    "export const native = 1;\n",
  "node_modules/eslint/node_modules/native-leaf/package.json": JSON.stringify({
    name: "native-leaf",
    version: "99.0.0",
  }),
  "node_modules/eslint/node_modules/@eslint/config-array/package.json":
    JSON.stringify({ name: configName, version: "99.0.0" }),
  [aliasKey + "/marker.js"]: "export const original = 1;\n",
  "node_modules/eslint/package.json": JSON.stringify({
    name: "eslint",
    version: "99.0.0",
  }),
});

test("native ESLint fixture copy binds the installed alias and publishes its canonical namespace without choosing the development package", async (t) => {
  const source = await fixture(t, files()),
    target = await fixture(t, {});
  await copyESLintParticipation(target, path.join(source, "node_modules"));
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(target, "node_modules/eslint/package.json"),
        "utf8",
      ),
    ),
    {
      name: "eslint",
      version,
      dependencies: {
        [configName]: "^" + configVersion,
        "native-leaf": "1.0.0",
      },
    },
  );
  assert.equal(
    await readFile(path.join(target, "node_modules/eslint/marker.js"), "utf8"),
    "export const original = 1;\n",
  );
  await assert.rejects(lstat(path.join(target, aliasKey)), { code: "ENOENT" });
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          target,
          "node_modules/eslint/node_modules/native-leaf/package.json",
        ),
        "utf8",
      ),
    ).version,
    "1.0.0",
  );
  assert.equal(
    await readFile(
      path.join(
        target,
        "node_modules/eslint/node_modules/native-leaf/marker.js",
      ),
      "utf8",
    ),
    "export const native = 1;\n",
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(target, "node_modules/@eslint/config-array/package.json"),
        "utf8",
      ),
    ).version,
    configVersion,
  );
  await assert.rejects(
    lstat(
      path.join(
        target,
        "node_modules/eslint/node_modules/@eslint/config-array",
      ),
    ),
    { code: "ENOENT" },
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(source, "node_modules/eslint/package.json"),
        "utf8",
      ),
    ).version,
    "99.0.0",
  );
});

test("native ESLint fixture alias drift fails before copying any artifact and only a verified frozen canonical namespace may substitute", async (t) => {
  const changes = [
    {
      file: "package.json",
      field: "declaration",
      patch: (entry: Record<string, unknown>) => {
        (entry.devDependencies as Record<string, string>)[alias] =
          "npm:eslint@0.0.0";
      },
    },
    {
      file: "package-lock.json",
      field: "lockfile",
      patch: (entry: Record<string, unknown>) => {
        entry.lockfileVersion = 2;
      },
    },
    {
      file: "package-lock.json",
      field: "lock root",
      patch: (entry: Record<string, unknown>) => {
        const entries = entry.packages as Record<
          string,
          { devDependencies?: Record<string, string> }
        >;
        entries[""]!.devDependencies![alias] = "npm:eslint@0.0.0";
      },
    },
    {
      file: "package-lock.json",
      field: "locked package name",
      patch: (entry: Record<string, unknown>) => {
        (entry.packages as Record<string, { name: string }>)[aliasKey]!.name =
          "other";
      },
    },
    {
      file: "package-lock.json",
      field: "locked version",
      patch: (entry: Record<string, unknown>) => {
        (entry.packages as Record<string, { version: string }>)[
          aliasKey
        ]!.version = "0.0.0";
      },
    },
    {
      file: aliasKey + "/package.json",
      field: "installed package name",
      patch: (entry: Record<string, unknown>) => {
        entry.name = "other";
      },
    },
    {
      file: aliasKey + "/package.json",
      field: "installed version",
      patch: (entry: Record<string, unknown>) => {
        entry.version = "0.0.0";
      },
    },
  ];
  for (const change of changes) {
    const source = await fixture(t, files()),
      target = await fixture(t, {});
    const file = path.join(source, change.file),
      value = JSON.parse(await readFile(file, "utf8"));
    change.patch(value);
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(
      copyESLintParticipation(target, path.join(source, "node_modules")),
      new RegExp(change.field),
    );
    await assert.rejects(lstat(path.join(target, "node_modules")), {
      code: "ENOENT",
    });
  }
  for (const file of [
    "package.json",
    "package-lock.json",
    "node_modules/@eslint/config-array/package.json",
  ]) {
    const source = await fixture(t, files()),
      target = await fixture(t, {});
    const location = path.join(source, file),
      value = JSON.parse(await readFile(location, "utf8"));
    if (file === "package.json") value.devDependencies[configName] = "0.0.0";
    else if (file === "package-lock.json")
      value.packages[""].devDependencies[configName] = "0.0.0";
    else value.version = "0.0.0";
    await writeFile(location, JSON.stringify(value));
    await assert.rejects(
      copyESLintParticipation(target, path.join(source, "node_modules")),
      /config-array/,
    );
    await assert.rejects(lstat(path.join(target, "node_modules")), {
      code: "ENOENT",
    });
  }
  {
    const changed = files();
    changed[aliasKey + "/node_modules/@eslint/config-array/package.json"] =
      JSON.stringify({ name: configName, version: "99.0.0" });
    const lock = JSON.parse(changed["package-lock.json"]);
    lock.packages[aliasKey + "/node_modules/@eslint/config-array"] = {
      version: "99.0.0",
    };
    changed["package-lock.json"] = JSON.stringify(lock);
    const source = await fixture(t, changed),
      target = await fixture(t, {});
    await assert.rejects(
      copyESLintParticipation(target, path.join(source, "node_modules")),
      /config-array copied resolution/,
    );
    await assert.rejects(lstat(path.join(target, "node_modules")), {
      code: "ENOENT",
    });
  }
  const prepared = await fixture(t, {
      "package.json": '{"private":true}',
      "node_modules/eslint/package.json": JSON.stringify({
        name: "eslint",
        version,
      }),
      ["node_modules/" + configName + "/package.json"]: JSON.stringify({
        name: configName,
        version: configVersion,
      }),
    }),
    target = await fixture(t, {});
  await copyESLintParticipation(target, path.join(prepared, "node_modules"));
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(target, "node_modules/eslint/package.json"),
        "utf8",
      ),
    ).version,
    version,
  );
  const foreign = await fixture(t, {
    "package.json": '{"private":true}',
    "node_modules/eslint/package.json": JSON.stringify({
      name: "eslint",
      version: "99.0.0",
    }),
  });
  await assert.rejects(
    copyESLintParticipation(
      await fixture(t, {}),
      path.join(foreign, "node_modules"),
    ),
    /installed version/,
  );
});
