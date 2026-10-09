import assert from "node:assert/strict";
import { test } from "node:test";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPlan } from "../src/engine.js";
import { identifyTool } from "../src/tool-versions.js";
import { planSchema } from "../src/schemas.js";
import { phpExtensionRuntime } from "../src/php-extension-pins.js";
import {
  phpExtensionsConfigSchema,
  phpTypedValueSchema,
  validatePhpProbeData,
} from "../src/php-extensions.js";
import { fixture } from "./helpers.js";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
test("PHP extension planning binds data and explicit sources without executing bootstrap classes or Composer autoload", async (t) => {
  const code =
    "<?php file_put_contents('executed.marker','must remain absent');";
  const config = {
    schemaVersion: 1,
    nativeExtensions: phpExtensionRuntime.extensions.map((e) => e.name),
    classes: [
      {
        class: "Original\\Item",
        path: "Item.php",
        sha256: hash(code),
        generated: false,
      },
      {
        class: "Original\\Proxy",
        path: ".checktrail/Proxy.php",
        sha256: hash(code),
        generated: true,
      },
    ],
    models: [
      {
        class: "Original\\Item",
        expectedClass: "Original\\Proxy",
        defaults: {
          table: "items",
          connection: null,
          keyName: "id",
          keyType: "int",
          incrementing: true,
          timestamps: true,
          perPage: 15,
          eagerLoads: [],
          eagerCounts: [],
          casts: { id: "int" },
          attributes: {},
          appends: [],
          fillable: [],
          guarded: ["*"],
        },
        probes: [
          {
            attribute: "label",
            attributes: {},
            expected: { type: "null", value: null },
          },
        ],
      },
    ],
  };
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["php.extensions"] }],
    }),
    "checktrail.php.json": JSON.stringify(config),
    "Item.php": code,
    ".checktrail/Proxy.php": code,
    "bootstrap/app.php": code,
    "vendor/autoload.php": code,
    "vendor/composer/ClassLoader.php": code,
    "vendor/composer/installed.json": "{}",
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(plan.checks[0]!.scope, [
    "Item.php",
    ".checktrail/Proxy.php",
  ]);
  assert.equal(plan.checks[0]!.commands.length, 1);
  assert.deepEqual(
    planSchema
      .parse(plan)
      .checks[0]!.tools?.filter((t) => t.source === "package-metadata")
      .map((t) => t.package),
    [
      "phpstan/phpstan",
      "larastan/larastan",
      "friendsofphp/php-cs-fixer",
      "laravel/framework",
    ],
  );
  await assert.rejects(access(path.join(root, "executed.marker")));
  await writeFile(
    path.join(root, ".checktrail/Proxy.php"),
    code + "\n// changed\n",
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /source bytes changed/,
  );
  for (const file of [
    "../outside.php",
    "/outside.php",
    "x\\outside.php",
    "a//b.php",
    "a/./b.php",
    "a/../b.php",
    "C:outside.php",
    "x\n.php",
  ]) {
    const bad = structuredClone(config);
    bad.classes[1]!.path = file;
    assert.equal(phpExtensionsConfigSchema.safeParse(bad).success, false, file);
  }
  assert.equal(
    phpExtensionsConfigSchema.safeParse({ ...config, allowExecution: true })
      .success,
    false,
  );
  assert.throws(
    () => validatePhpProbeData({ value: 9007199254740992 }),
    /finite/,
  );
});
test("Composer tool identity requires one exact package and never imports metadata neighbors or executes a version command", async (t) => {
  const root = await fixture(t, {
    "metadata.json": JSON.stringify({
      packages: [
        { name: "phpstan/phpstan-extra", version: "99.0.0" },
        { name: "phpstan/phpstan", version: "2.2.14" },
      ],
    }),
  });
  const spec = {
    name: "phpstan",
    source: "package-metadata" as const,
    path: path.join(root, "metadata.json"),
    package: "phpstan/phpstan",
  };
  let calls = 0;
  const execute = async () => {
    calls++;
    throw Error("No metadata query may execute code");
  };
  const native = await identifyTool(root, spec, execute);
  assert.equal(native.status, "identified");
  assert.equal(native.version, "2.2.14");
  for (const packages of [
    [{ name: "phpstan/phpstan-extra", version: "2.2.14" }],
    [
      { name: "phpstan/phpstan", version: "2.2.14" },
      { name: "phpstan/phpstan", version: "2.2.14" },
    ],
    [{ name: "phpstan/phpstan", version: "future" }],
    [{ name: "phpstan/phpstan", version: 2.2 }],
    [],
  ]) {
    await writeFile(spec.path, JSON.stringify({ packages }));
    assert.equal(
      (await identifyTool(root, spec, execute)).status,
      "inconclusive",
    );
  }
  for (const value of [
    { type: "int", value: "1" },
    { type: "int", value: 1.5 },
    { type: "bool", value: 1 },
    { type: "array", value: { n: 1 } },
    {
      type: "array",
      value: [
        {
          key: { type: "string", value: "n" },
          value: { type: "int", value: "1" },
        },
      ],
    },
  ])
    assert.equal(phpTypedValueSchema.safeParse(value).success, false);
  assert.equal(
    phpTypedValueSchema.safeParse({
      type: "array",
      value: [
        {
          key: { type: "string", value: "n" },
          value: { type: "int", value: 1 },
        },
      ],
    }).success,
    true,
  );
  assert.equal(calls, 0);
});
