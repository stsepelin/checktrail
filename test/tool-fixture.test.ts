import assert from "node:assert/strict";
import {
  access,
  readFile,
  realpath,
  mkdir,
  writeFile,
  symlink,
  readlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";
import { withinRoot } from "../src/inventory.js";

const pins: Record<string, string> = {
  "@synthetic-sdk/server": "1.0.0",
  "@synthetic-sdk/core": "1.0.0",
  "@synthetic-sdk/client": "1.0.0",
  "@synthetic-sdk/client/node_modules/@synthetic-sdk/core": "2.0.0",
};
async function installed(t: TestContext) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, type: "commonjs" }),
  };
  for (const [location, version] of Object.entries(pins)) {
    const name = location.includes("/node_modules/")
      ? "@synthetic-sdk/core"
      : location;
    files["node_modules/" + location + "/package.json"] = JSON.stringify({
      name,
      version,
      main: "index.cjs",
      ...(name.endsWith("/core")
        ? {}
        : {
            dependencies: {
              "@synthetic-sdk/core": name.endsWith("/client")
                ? "2.0.0"
                : "1.0.0",
            },
          }),
    });
    files["node_modules/" + location + "/index.cjs"] = name.endsWith("/core")
      ? "module.exports = " + JSON.stringify(version) + ";"
      : "module.exports = require('@synthetic-sdk/core');";
  }
  return realpath(await fixture(t, files));
}

test("acceptance dependency copying preserves two core versions and actual client/server module resolution", async (t) => {
  const source = await installed(t),
    destination = await realpath(await fixture(t, {}));
  const sourceCore = path.join(
    source,
    "node_modules/@synthetic-sdk/core/index.cjs",
  );
  const before = await readFile(sourceCore);
  const checked: string[] = [];
  await copyInstalledPackages(
    destination,
    ["@synthetic-sdk/server", "@synthetic-sdk/client"],
    path.join(source, "node_modules"),
    async ({ relative, version }) => {
      await delay(1);
      const location = relative.split(path.sep).join("/");
      assert.ok(Object.hasOwn(pins, location));
      assert.equal(version, pins[location]);
      checked.push(location);
    },
  );
  const require = createRequire(path.join(destination, "package.json"));
  assert.equal(require("@synthetic-sdk/server"), "1.0.0");
  assert.equal(require("@synthetic-sdk/client"), "2.0.0");
  assert.deepEqual(checked.sort(), Object.keys(pins).sort());
  assert.deepEqual(await readFile(sourceCore), before);
});

test("acceptance dependency validation rejects a later nested version before copying any earlier package", async (t) => {
  const source = await installed(t),
    destination = await realpath(await fixture(t, {}));
  const checked: string[] = [];
  await assert.rejects(
    copyInstalledPackages(
      destination,
      ["@synthetic-sdk/server", "@synthetic-sdk/client"],
      path.join(source, "node_modules"),
      async ({ relative, version }) => {
        await delay(1);
        const location = relative.split(path.sep).join("/");
        checked.push(location);
        if (location.includes("/node_modules/") && version !== "1.0.0")
          throw new Error("Locked nested package version changed");
      },
    ),
    /Locked nested package version changed/,
  );
  assert.equal(checked.length, Object.keys(pins).length);
  await assert.rejects(access(path.join(destination, "node_modules")), {
    code: "ENOENT",
  });
});

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
