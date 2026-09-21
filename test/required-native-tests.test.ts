import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";

test("required native runner rejects skipped, todo, absent, duplicate and failing cases", async (t) => {
  const root = await fixture(t, {
    "runner.mjs":
      "const {runRequiredTests}=await import(process.argv[2]);console.log(JSON.stringify(await runRequiredTests(JSON.parse(process.argv[3]))));",
    "passed.mjs":
      "import {test} from 'node:test';test('native-required',()=>{});test('unit',()=>{});",
    "skipped.mjs":
      "import {test} from 'node:test';test('native-required',{skip:'missing tool'},()=>{});test('unit',()=>{});",
    "dynamic.mjs":
      "import {test} from 'node:test';test('native-required',t=>t.skip(''));",
    "todo.mjs":
      "import {test} from 'node:test';test('native-required',{todo:true},()=>{});",
    "absent.mjs":
      "import {test} from 'node:test';test('native-required-extra',()=>{});",
    "duplicate.mjs":
      "import {test} from 'node:test';test('native-required',()=>{});test('native-required',()=>{});",
    "failure.mjs":
      "import {test} from 'node:test';test('native-required',()=>{});test('other',()=>{throw new Error('synthetic failure')});",
    "suite.mjs":
      "import {describe,it} from 'node:test';describe('native-required',()=>{it('other',()=>{})});",
    "other-file.mjs":
      "import {test} from 'node:test';test('native-required',()=>{});test('other',()=>{});",
  });
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  function run(requirements: { file: string; name: string }[]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "runner.mjs"),
        new URL("../../scripts/required-test-evidence.mjs", import.meta.url)
          .href,
        JSON.stringify(requirements),
      ],
      { encoding: "utf8", timeout: 10000, env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      complete: boolean;
      passed: number;
      problems: { name: string; reason: string }[];
    };
  }
  const required = (file: string) => ({
    file: path.join(root, file),
    name: "native-required",
  });
  const passed = run([required("passed.mjs")]);
  assert.equal(passed.complete, true, JSON.stringify(passed));
  assert.equal(passed.passed, 2);
  for (const file of [
    "skipped.mjs",
    "dynamic.mjs",
    "todo.mjs",
    "absent.mjs",
    "duplicate.mjs",
    "failure.mjs",
    "suite.mjs",
    "missing.mjs",
  ]) {
    const result = run([required(file)]);
    assert.equal(result.complete, false, file);
    assert.ok(result.problems.length > 0, file);
  }
  const wrongFile = run([
    required("absent.mjs"),
    { file: path.join(root, "other-file.mjs"), name: "other" },
  ]);
  assert.equal(wrongFile.complete, false);
  assert.deepEqual(wrongFile.problems, [
    { name: "native-required", reason: "required-test-not-passed" },
  ]);
});
