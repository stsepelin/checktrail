import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI plans without trust, runs with trust, and returns machine-readable output", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "sum.test.js": passingTest,
  });
  const plan = await exec(process.execPath, [cli, "plan", "--root", root]);
  assert.equal(JSON.parse(plan.stdout).projectCount, 1);
  assert.equal(plan.stderr, "");
  const run = await exec(process.execPath, [
    cli,
    "run",
    "--root",
    root,
    "--trust-project",
  ]);
  assert.equal(JSON.parse(run.stdout).outcome, "passed");
  await assert.rejects(
    exec(process.execPath, [cli, "run", "--root", root]),
    (error: unknown) => {
      assert.equal((error as { code: number }).code, 2);
      return true;
    },
  );
});

test("CLI uses different exit codes for failed and incomplete checks", async (t) => {
  for (const [code, expected] of [
    [
      "import { test } from 'node:test'; test('fails', () => { throw Error('bad'); });",
      1,
    ],
    ["", 2],
  ] as const) {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "case.test.js": code,
    });
    await assert.rejects(
      exec(process.execPath, [cli, "run", "--root", root, "--trust-project"]),
      (error: unknown) => {
        assert.equal((error as { code: number }).code, expected);
        return true;
      },
    );
  }
});
