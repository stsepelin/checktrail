import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("performance samples reject fast failures, incomplete test execution and incorrect planning counts", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "value.test.js": passingTest,
  });
  const worker = fileURLToPath(
    new URL("../../scripts/performance-worker.mjs", import.meta.url),
  );
  const invoke = (
    directory: string,
    mode: string,
    projects: string,
    files: string,
  ) =>
    spawnSync(process.execPath, [worker, directory, mode, projects, files], {
      encoding: "utf8",
      timeout: 5000,
    });
  for (const mode of ["plan", "validate"]) {
    const good = invoke(root, mode, "1", "2");
    assert.equal(good.status, 0, good.stderr);
    const report = JSON.parse(good.stdout) as {
      checks: number;
      executedTests: number;
      engineMs: number;
      engineCpuMs: number;
      enginePeakRssKiB: number;
    };
    assert.equal(report.checks, 1);
    assert.equal(report.executedTests, mode === "plan" ? 0 : 1);
    assert.ok(
      report.engineMs > 0 &&
        report.engineCpuMs > 0 &&
        report.enginePeakRssKiB > 0,
    );
  }
  for (const [projects, files] of [
    ["2", "2"],
    ["1", "3"],
  ]) {
    const wrong = invoke(root, "plan", projects!, files!);
    assert.equal(wrong.status, 1);
    assert.equal(wrong.stdout, "");
  }
  for (const content of [
    "",
    "import {test} from 'node:test'; test.skip('not executed', () => {});",
    "import {test} from 'node:test'; test('broken', () => { throw new Error('broken fixture'); });",
  ]) {
    const broken = await fixture(t, {
      "package.json": nodeManifest,
      "value.test.js": content,
    });
    const result = invoke(broken, "validate", "1", "2");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});
