import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  mkdir,
  writeFile,
  readFile,
  symlink,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";
import { withinRoot } from "../src/inventory.js";
test("selected synthetic tool dependencies cannot fall back outside their physical installation, including optional packages", async (t) => {
  const base = await fixture(t, {
      "node_modules/original-escape/package.json":
        '{"name":"original-escape","version":"1.0.0"}',
      "cohort/package.json": "{}",
      "cohort/node_modules/original-entry/package.json":
        '{"name":"original-entry","version":"1.0.0","dependencies":{"original-escape":"1.0.0"}}',
    }),
    out = await fixture(t, {}),
    modules = path.join(base, "cohort/node_modules");
  await assert.rejects(
    copyInstalledPackages(out, ["original-entry"], modules),
    /Missing installed test dependency original-escape/,
  );
  assert.equal(
    await access(path.join(out, "node_modules")).then(
      () => true,
      () => false,
    ),
    false,
    "A missing required dependency must be detected before any copy",
  );
  await writeFile(
    path.join(modules, "original-entry/package.json"),
    '{"name":"original-entry","version":"1.0.0","optionalDependencies":{"original-escape":"1.0.0"}}',
  );
  await copyInstalledPackages(out, ["original-entry"], modules);
  assert.equal(
    await access(path.join(out, "node_modules/original-escape")).then(
      () => true,
      () => false,
    ),
    false,
  );
  await mkdir(path.join(modules, "original-escape"));
  await writeFile(
    path.join(modules, "original-escape/package.json"),
    '{"name":"original-escape","version":"1.0.0"}',
  );
  await symlink(
    "../original-escape/package.json",
    path.join(modules, "original-entry/shortcut"),
  );
  const near = await fixture(t, {});
  await copyInstalledPackages(near, ["original-entry"], modules);
  assert.equal(
    await readlink(path.join(near, "node_modules/original-entry/shortcut")),
    "../original-escape/package.json",
  );
  assert.equal(
    await withinRoot(near, "node_modules/original-entry/shortcut"),
    path.join(
      await realpath(near),
      "node_modules/original-escape/package.json",
    ),
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(near, "node_modules/original-escape/package.json"),
        "utf8",
      ),
    ).name,
    "original-escape",
  );
});
