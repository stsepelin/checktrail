import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

const inputs = [
  "scripts/prepare-playwright-tools.mjs",
  "scripts/playwright-tools/package.json",
  "scripts/playwright-tools/package-lock.json",
];
async function profileFiles() {
  return Object.fromEntries(
    await Promise.all(
      inputs.map(async (file) => [
        file,
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ]),
    ),
  );
}
const publish = (root: string) =>
  spawnSync(process.execPath, ["scripts/prepare-playwright-tools.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });

test("Playwright fixture preparation ignores development upgrades and atomically preserves the pinned canonical graph", async (t) => {
  const files = await profileFiles();
  const development = '{"devDependencies":{"@playwright/test":"9.99.0"}}';
  const root = await fixture(t, {
    ...files,
    "package.json": development,
    "package-lock.json": "not a qualification input",
  });
  const result = publish(root);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).versions, {
    "@playwright/test": "1.64.1",
  });
  assert.equal(JSON.parse(result.stdout).rangeResolutionPerformed, false);
  const directory = path.join(root, ".checktrail/playwright-tools");
  assert.deepEqual((await readdir(directory)).sort(), [
    "package-lock.json",
    "package.json",
  ]);
  for (const name of ["package.json", "package-lock.json"])
    assert.equal(
      await readFile(path.join(directory, name), "utf8"),
      files["scripts/playwright-tools/" + name],
    );
  assert.equal(
    await readFile(path.join(root, "package.json"), "utf8"),
    development,
  );
  const second = publish(root);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Missing expected rejection/);
  for (const name of ["package.json", "package-lock.json"])
    assert.equal(
      await readFile(path.join(directory, name), "utf8"),
      files["scripts/playwright-tools/" + name],
    );
});

test("invalid Playwright qualification artifacts publish nothing and cannot fall back to current root dependencies", async (t) => {
  const files = await profileFiles();
  for (const [target, edit, reason] of [
    [
      "package.json",
      (value: Record<string, unknown>) => {
        value.dependencies = { "@playwright/test": "^1.64.1" };
      },
      /must be exactly pinned/,
    ],
    [
      "package-lock.json",
      (value: Record<string, unknown>) => {
        const packages = value.packages as Record<string, { version: string }>;
        packages["node_modules/playwright"]!.version = "1.65.0";
      },
      /lock must match its declaration: playwright/,
    ],
    [
      "package-lock.json",
      (value: Record<string, unknown>) => {
        const packages = value.packages as Record<string, unknown>;
        delete packages["node_modules/playwright-core"];
      },
      /complete canonical package graph/,
    ],
    [
      "package-lock.json",
      (value: Record<string, unknown>) => {
        const packages = value.packages as Record<
          string,
          { integrity: string }
        >;
        packages["node_modules/playwright"]!.integrity = "sha256-wrong";
      },
      /integrity missing or malformed/,
    ],
    [
      "package-lock.json",
      (value: Record<string, unknown>) => {
        const packages = value.packages as Record<string, { resolved: string }>;
        packages["node_modules/playwright"]!.resolved =
          "https://registry.npmjs.org.invalid/playwright.tgz";
      },
      /must use the pinned registry/,
    ],
  ] as const) {
    const name = "scripts/playwright-tools/" + target;
    const value = JSON.parse(files[name]!);
    edit(value);
    const root = await fixture(t, {
      ...files,
      [name]: JSON.stringify(value),
      "package.json": '{"devDependencies":{"@playwright/test":"1.65.0"}}',
    });
    const result = publish(root);
    assert.notEqual(result.status, 0, target);
    assert.match(result.stderr, reason);
    await assert.rejects(access(path.join(root, ".checktrail")), {
      code: "ENOENT",
    });
  }
});
