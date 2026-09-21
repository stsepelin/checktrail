import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.vitest"] }],
});
const good =
  "import {test, expect} from 'vitest'; test('adds',()=>expect(2+3).toBe(5));\n";

test(
  "native Vitest records assertions, catches failures and rejects all-skipped and excluded test files",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": policy,
      "vitest.config.mjs":
        "export default {test:{outputFile:'should-not-write.json'}};\n",
      "sum.test.ts": good,
    });
    await copyInstalledPackages(root, ["vitest", "vite"]);
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    await assert.rejects(access(path.join(root, "should-not-write.json")));
    await assert.rejects(access(path.join(root, ".vitest")));
    await writeFile(
      path.join(root, "sum.test.ts"),
      "import {test,expect} from 'vitest'; test('fails',()=>expect(2+3).toBe(6));\n",
    );
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.checks[0]!.tests?.failed, 1);
    await writeFile(
      path.join(root, "sum.test.ts"),
      "import {test} from 'vitest'; test.skip('later',()=>{}); test.todo('future');\n",
    );
    const skipped = await validate(root, { trusted: true });
    assert.equal(skipped.outcome, "incomplete", JSON.stringify(skipped.checks));
    assert.equal(skipped.checks[0]!.tests?.passed, 0);
    await writeFile(path.join(root, "sum.test.ts"), good);
    await writeFile(path.join(root, "omitted.test.ts"), good);
    await writeFile(
      path.join(root, "vitest.config.mjs"),
      "export default {test:{exclude:['omitted.test.ts']}};\n",
    );
    const omitted = await validate(root, { trusted: true });
    assert.equal(omitted.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(omitted.outcome, "incomplete");
  },
);

test("Vitest planning and missing-tool validation never execute project configuration", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": policy,
    "vitest.config.mjs": "throw new Error('configuration ran');",
    "sum.test.ts": good,
  });
  const report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "unavailable");
  assert.equal(report.checks[0]!.processes.length, 0);
  assert.equal(
    (await createPlan(root)).plan.checks[0]!.id,
    "javascript.vitest",
  );
});

test(
  "Vitest forbids focused tests, unhandled-error bypasses and snapshot updates",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": policy,
      "vitest.config.mjs":
        "export default {test:{allowOnly:true,update:'all',dangerouslyIgnoreUnhandledErrors:true,onUnhandledError:()=>false}};\n",
      "sum.test.js":
        "import {test,expect} from 'vitest'; test.only('focused',()=>expect(1).toBe(1)); test('hidden failure',()=>expect(1).toBe(2));\n",
    });
    await copyInstalledPackages(root, ["vitest", "vite"]);
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      path.join(root, "sum.test.js"),
      "import {test,expect} from 'vitest'; test('snapshot',()=>expect({value:42}).toMatchSnapshot());\n",
    );
    const snapshot = await validate(root, { trusted: true });
    assert.equal(snapshot.outcome, "failed", JSON.stringify(snapshot.checks));
    assert.equal(snapshot.sourceChanged, false);
    await assert.rejects(access(path.join(root, "__snapshots__")));
    await writeFile(
      path.join(root, "sum.test.js"),
      "import {test,expect} from 'vitest'; test('unhandled',async()=>{Promise.reject(new Error('synthetic unhandled'));await new Promise(resolve=>setTimeout(resolve,30));expect(1).toBe(1)});\n",
    );
    const unhandled = await validate(root, { trusted: true });
    assert.notEqual(unhandled.outcome, "passed");
    assert.match(JSON.stringify(unhandled.checks), /synthetic unhandled/);
    await writeFile(path.join(root, "sum.test.js"), good);
    await writeFile(
      path.join(root, "vitest.config.mjs"),
      "export default {test:{environment:'checktrail-missing-environment'}};\n",
    );
    const missing = await validate(root, { trusted: true });
    assert.notEqual(missing.outcome, "passed");
    assert.equal(missing.sourceChanged, false);
    assert.match(
      JSON.stringify(missing.checks),
      /Install required Vitest dependency locally/,
    );
  },
);
