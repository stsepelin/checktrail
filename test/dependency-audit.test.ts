import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("dependency audit reconciles installed metadata, reports missing notices and rejects drift", async (t) => {
  const script = await readFile(
    new URL("../../scripts/audit-dependencies.mjs", import.meta.url),
    "utf8",
  );
  const rootPackage = {
    name: "synthetic-audit",
    version: "1.0.0",
    private: true,
    dependencies: { "synthetic-module": "1.0.0" },
  };
  const dependency = {
    name: "synthetic-module",
    version: "1.0.0",
    license: "MIT",
  };
  const root = await fixture(t, {
    "scripts/audit-dependencies.mjs": script,
    "scripts/license-sources.json": "{}",
    "package.json": JSON.stringify(rootPackage),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      name: rootPackage.name,
      version: rootPackage.version,
      packages: {
        "": rootPackage,
        "node_modules/synthetic-module": {
          ...dependency,
          resolved:
            "https://registry.npmjs.org/synthetic-module/-/synthetic-module-1.0.0.tgz",
          integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        },
      },
    }),
    "node_modules/synthetic-module/package.json": JSON.stringify(dependency),
    "node_modules/synthetic-module/LICENSE":
      "Synthetic notice used only to test notice presence accounting.\n",
  });
  const invoke = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/audit-dependencies.mjs")],
      { cwd: root, encoding: "utf8", timeout: 15000 },
    );
  let result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.packageCount, 1);
  assert.equal(report.packages[0].notices.length, 1);
  assert.ok(!result.stdout.includes(root));
  await rm(path.join(root, "node_modules/synthetic-module/LICENSE"));
  result = invoke();
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false);
  assert.deepEqual(JSON.parse(result.stdout).gaps, [
    { package: "synthetic-module@1.0.0", reason: "No notice file was located" },
  ]);
  await writeFile(
    path.join(root, "node_modules/synthetic-module/package.json"),
    JSON.stringify({ ...dependency, license: "ISC" }),
  );
  result = invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /license declaration differs/);
  await writeFile(
    path.join(root, "node_modules/synthetic-module/package.json"),
    JSON.stringify(dependency),
  );
  await writeFile(
    path.join(root, "scripts/license-sources.json"),
    JSON.stringify({ "missing-module@1.0.0": {} }),
  );
  result = invoke();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer describes/);
});
