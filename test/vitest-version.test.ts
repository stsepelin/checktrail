import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runProcess } from "../src/runner.js";
import { vitestMajor } from "../src/vitest-version.js";
import { fixture } from "./helpers.js";

const runner = fileURLToPath(
  new URL("../src/vitest-runner.js", import.meta.url),
);

test("Vitest version routing accepts stable 4/5 and rejects malformed or unsupported metadata", () => {
  for (const version of ["4.0.0", "4.1.9", "4.12.20"])
    assert.equal(vitestMajor({ name: "vitest", version }), 4);
  for (const version of ["5.0.1", "5.10.2"])
    assert.equal(vitestMajor({ name: "vitest", version }), 5);
  for (const version of [
    "3.2.4",
    "6.0.0",
    "40.1.0",
    "4.1",
    "5.0.0-beta.1",
    "4.01.9",
    "4.1.9\n",
    4,
    null,
  ])
    assert.throws(
      () => vitestMajor({ name: "vitest", version }),
      /Unsupported Vitest/,
    );
  for (const metadata of [null, [], {}, { name: "other", version: "4.1.9" }])
    assert.throws(() => vitestMajor(metadata), /Unsupported Vitest/);
});

for (const major of [4, 5]) {
  test(`Vitest ${major} runner passes the matching API arguments and safety options`, async (t) => {
    const root = await fixture(t, {
      "node_modules/vitest/package.json": JSON.stringify({
        name: "vitest",
        type: "module",
        version: `${major}.1.0`,
      }),
      "node_modules/vitest/dist/node.js": `
import assert from 'node:assert/strict';
export class JsonReporter { constructor(options) { this.options = options; } }
export class VitestPackageInstaller { isPackageExists() { return false; } }
export async function startVitest(...args) {
  assert.equal(args.length, ${major === 4 ? 5 : 4});
  ${major === 4 ? "assert.equal(args.shift(), 'test');" : ""}
  const [filters, options, overrides, runtime] = args;
  assert.deepEqual(filters, [process.cwd() + '/sum.test.js']);
  assert.equal(overrides, undefined);
  assert.equal(options.root, process.cwd());
  assert.equal(options.run, true);
  for (const key of ['watch', 'allowOnly', 'passWithNoTests', 'dangerouslyIgnoreUnhandledErrors', 'cache']) assert.equal(options[key], false);
  assert.equal(options.update, 'none');
  assert.equal(options.onUnhandledError(), true);
  assert.deepEqual(options.reporters[0].options, {stdout: true, outputFile: ''});
  assert.equal(${major === 4 ? "options.experimental.fsModuleCache" : "options.fsModuleCache"}, false);
  await assert.rejects(runtime.packageInstaller.ensureInstalled('missing', process.cwd()), /Install required Vitest dependency locally/);
  runtime.packageInstaller.isPackageExists = () => true;
  assert.equal(await runtime.packageInstaller.ensureInstalled('present', process.cwd()), true);
  return {state: {getUnhandledErrors: () => []}, close: async () => process.stdout.write('closed')};
}
`,
      "sum.test.js": "",
    });
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          runner,
          path.join(root, "node_modules/vitest/dist/node.js"),
          root,
          "sum.test.js",
        ],
        cwd: ".",
      },
      { timeoutMs: 5000 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "closed");
  });
}

test("unsupported Vitest fails before importing tool or executing configuration", async (t) => {
  const root = await fixture(t, {
    "node_modules/vitest/package.json":
      '{"name":"vitest","version":"6.0.0","type":"module"}',
    "node_modules/vitest/dist/node.js": "throw new Error('tool imported');",
    "sum.test.js": "",
  });
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: [
        runner,
        path.join(root, "node_modules/vitest/dist/node.js"),
        root,
        "sum.test.js",
      ],
      cwd: ".",
    },
    { timeoutMs: 5000 },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unsupported Vitest/);
  assert.doesNotMatch(result.stderr, /tool imported/);
  assert.equal(result.stdout, "");
});

test("Vitest closes its context when reading execution errors fails", async (t) => {
  const root = await fixture(t, {
    "node_modules/vitest/package.json":
      '{"name":"vitest","version":"4.1.9","type":"module"}',
    "node_modules/vitest/dist/node.js": `
export class JsonReporter {}
export class VitestPackageInstaller {}
export async function startVitest() {
  return {state: {getUnhandledErrors() {throw new Error('error state failed');}}, close: async () => process.stdout.write('closed')};
}`,
    "sum.test.js": "",
  });
  const result = await runProcess(
    root,
    {
      executable: process.execPath,
      args: [
        runner,
        path.join(root, "node_modules/vitest/dist/node.js"),
        root,
        "sum.test.js",
      ],
      cwd: ".",
    },
    { timeoutMs: 5000 },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "closed");
  assert.match(result.stderr, /error state failed/);
});
