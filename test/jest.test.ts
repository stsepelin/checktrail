import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.jest"] }],
});
const good = "test('adds',()=>expect(2+3).toBe(5));\n";

test(
  "native Jest requires executed tests and accounts for excluded, skipped, focused and failed cases",
  { timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": "{}",
      "checktrail.json": policy,
      "jest.config.cjs":
        "module.exports={collectTests:true,outputFile:'should-not-write.json',testResultsProcessor:'./processor.cjs'};\n",
      "processor.cjs": "throw new Error('results processor must not run');\n",
      "sum.test.js": good,
      "__tests__/nested.js": good,
    });
    await copyInstalledPackages(root, ["jest"]);
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    await assert.rejects(access(path.join(root, "should-not-write.json")));
    for (const [source, outcome] of [
      ["test('fails',()=>expect(2+3).toBe(6));", "failed"],
      ["test.skip('later',()=>{});", "incomplete"],
      [
        "test.only('focused',()=>expect(1).toBe(1)); test('omitted failure',()=>expect(1).toBe(2));",
        "incomplete",
      ],
      [
        "describe.only('focus',()=>test('passes',()=>expect(1).toBe(1)));test('omitted failure',()=>expect(1).toBe(2));",
        "incomplete",
      ],
      ["test('snapshot',()=>expect({value:42}).toMatchSnapshot());", "failed"],
      ["throw new Error('synthetic import failure');", "failed"],
      ["", "failed"],
    ]) {
      await writeFile(path.join(root, "sum.test.js"), source!);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, outcome, JSON.stringify(result.checks));
      assert.equal(result.sourceChanged, false);
    }
    await assert.rejects(access(path.join(root, "__snapshots__")));
    await writeFile(path.join(root, "sum.test.js"), good);
    await writeFile(
      path.join(root, "jest.config.cjs"),
      "module.exports={testPathIgnorePatterns:['sum.test.js']};\n",
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(excluded.outcome, "incomplete");
  },
);

test("Jest planning and missing-tool validation do not execute configuration", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy,
    "jest.config.cjs": "throw new Error('configuration ran');",
    "sum.test.js": good,
  });
  assert.equal((await createPlan(root)).plan.checks[0]!.id, "javascript.jest");
  const result = await validate(root, { trusted: true });
  assert.equal(result.checks[0]!.status, "unavailable");
  assert.equal(result.checks[0]!.processes.length, 0);
});
