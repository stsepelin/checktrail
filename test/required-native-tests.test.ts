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
    "bounded-failure.mjs":
      "import {test} from 'node:test';test('native-required',()=>{});test('other',()=>{throw new Error('x'.repeat(1200))});",
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
      problems: {
        name: string;
        reason: string;
        failureType?: string;
        code?: string;
        message?: string;
      }[];
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
  const failure = run([required("failure.mjs")]);
  assert.equal(failure.complete, false);
  assert.deepEqual(
    failure.problems.find((problem) => problem.name === "other"),
    {
      name: "other",
      reason: "failed",
      failureType: "testCodeFailure",
      code: "ERR_TEST_FAILURE",
      message: "synthetic failure",
    },
  );
  const boundedFailure = run([required("bounded-failure.mjs")]);
  assert.equal(boundedFailure.complete, false);
  assert.equal(
    boundedFailure.problems.find((problem) => problem.name === "other")
      ?.message,
    "x".repeat(1000),
  );
  const wrongFile = run([
    required("absent.mjs"),
    { file: path.join(root, "other-file.mjs"), name: "other" },
  ]);
  assert.equal(wrongFile.complete, false);
  assert.deepEqual(wrongFile.problems, [
    { name: "native-required", reason: "required-test-not-passed" },
  ]);
});

test("required profile batches execute shared files once and preserve all obligations", async (t) => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const root = await fixture(t, {
    "batch.mjs":
      "const {runRequiredProfiles}=await import(process.argv[2]);console.log(JSON.stringify(await runRequiredProfiles(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]),{timeoutMs:1000,...JSON.parse(process.argv[5])})));",
    "shared.mjs":
      "import {appendFileSync} from 'node:fs';import {test} from 'node:test';appendFileSync(process.env.BATCH_MARKER,'shared\\n');test('alpha',()=>{});test('beta',()=>{});test('extra',()=>{});",
    "other.mjs": "import {test} from 'node:test';test('alpha',()=>{});",
    "skip.mjs":
      "import {test} from 'node:test';test('required',{skip:true},()=>{});",
    "todo.mjs":
      "import {test} from 'node:test';test('required',{todo:true},()=>{});",
    "empty-skip.mjs":
      "import {test} from 'node:test';test('required',t=>t.skip(''));",
    "duplicate.mjs":
      "import {test} from 'node:test';test('required',()=>{});test('required',()=>{});",
    "failed.mjs":
      "import {test} from 'node:test';test('required',()=>{});test('unrelated',()=>{throw new Error('synthetic')});",
    "suite.mjs":
      "import {describe,it} from 'node:test';describe('required',()=>{it('child',()=>{})});",
    "hang.mjs":
      "import {test} from 'node:test';test('required',{timeout:20},()=>new Promise(resolve=>setTimeout(resolve,100)));",
  });
  const marker = path.join(root, "marker");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BATCH_MARKER: marker,
  };
  delete environment.NODE_TEST_CONTEXT;
  const requirement = (file: string, name: string) => ({
    file: path.join(root, file),
    name,
  });
  const alpha = requirement("shared.mjs", "alpha");
  const beta = requirement("shared.mjs", "beta");
  const helper = new URL(
    "../../scripts/required-test-evidence.mjs",
    import.meta.url,
  );
  function invoke(
    profiles: object,
    selection = ["first", "second"],
    options: object = {},
  ) {
    return spawnSync(
      process.execPath,
      [
        path.join(root, "batch.mjs"),
        helper.href,
        JSON.stringify(profiles),
        JSON.stringify(selection),
        JSON.stringify(options),
      ],
      { encoding: "utf8", env: environment, timeout: 10000 },
    );
  }
  const report = invoke({ first: [alpha], second: [alpha, beta] });
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout), {
    profiles: [
      { profile: "first", required: 1 },
      { profile: "second", required: 2 },
    ],
    passed: 3,
    required: 2,
    problems: [],
    complete: true,
  });
  assert.equal(await readFile(marker, "utf8"), "shared\n");
  for (const profiles of [
    { first: [alpha] },
    { first: [alpha], second: [] },
    {
      first: [alpha],
      second: [alpha, { ...alpha, file: path.join(root, ".", "shared.mjs") }],
    },
    { first: [alpha], second: [{ file: 4, name: "wrong" }] },
  ]) {
    await writeFile(marker, "");
    assert.notEqual(invoke(profiles).status, 0);
    assert.equal(
      await readFile(marker, "utf8"),
      "",
      "validate all profiles before executing files",
    );
  }
  await writeFile(marker, "");
  assert.notEqual(invoke({ first: [alpha] }, ["first", "first"]).status, 0);
  assert.equal(await readFile(marker, "utf8"), "");
  for (const file of [
    "skip.mjs",
    "todo.mjs",
    "duplicate.mjs",
    "failed.mjs",
    "suite.mjs",
    "hang.mjs",
    "missing.mjs",
  ]) {
    const result = invoke({
      first: [alpha],
      second: [requirement(file, "required")],
    });
    assert.equal(result.status, 0, result.stderr);
    const failed = JSON.parse(result.stdout);
    assert.equal(failed.complete, false, file);
    assert.ok(failed.problems.length > 0, file);
  }
  const wrongFile = invoke({
    first: [alpha],
    second: [requirement("other.mjs", "beta")],
  });
  assert.equal(wrongFile.status, 0, wrongFile.stderr);
  assert.equal(JSON.parse(wrongFile.stdout).complete, false);

  const optional = invoke({ first: [alpha], second: [beta] }, undefined, {
    additionalFiles: [path.join(root, "skip.mjs")],
  });
  assert.equal(optional.status, 0, optional.stderr);
  assert.equal(JSON.parse(optional.stdout).complete, true);
  assert.equal(JSON.parse(optional.stdout).optionalSkipped, 1);
  assert.equal(JSON.parse(optional.stdout).files, 2);
  const emptySkip = invoke({ first: [alpha], second: [beta] }, undefined, {
    additionalFiles: [path.join(root, "empty-skip.mjs")],
  });
  assert.equal(emptySkip.status, 0, emptySkip.stderr);
  assert.equal(JSON.parse(emptySkip.stdout).complete, true);
  assert.equal(JSON.parse(emptySkip.stdout).optionalSkipped, 1);
  const optionalTodo = invoke({ first: [alpha], second: [beta] }, undefined, {
    additionalFiles: [path.join(root, "todo.mjs")],
  });
  assert.equal(optionalTodo.status, 0, optionalTodo.stderr);
  assert.equal(JSON.parse(optionalTodo.stdout).complete, false);
  // Adding the skipped file to a required profile must override optional status.
  const requiredSkip = invoke(
    { first: [alpha], second: [requirement("skip.mjs", "required")] },
    undefined,
    { additionalFiles: [path.join(root, "skip.mjs")] },
  );
  assert.equal(requiredSkip.status, 0, requiredSkip.stderr);
  assert.equal(JSON.parse(requiredSkip.stdout).complete, false);
  const optionalFailure = invoke(
    { first: [alpha], second: [beta] },
    undefined,
    { additionalFiles: [path.join(root, "failed.mjs")] },
  );
  assert.equal(optionalFailure.status, 0, optionalFailure.stderr);
  assert.equal(JSON.parse(optionalFailure.stdout).complete, false);

  // Exercise CLI exit status and keep the single-profile acceptance format.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts/required-test-evidence.mjs"),
    await readFile(helper),
  );
  await writeFile(
    path.join(root, "scripts/verify.mjs"),
    await readFile(
      new URL(
        "../../scripts/verify-required-native-tests.mjs",
        import.meta.url,
      ),
    ),
  );
  await writeFile(
    path.join(root, "scripts/required-native-tests.json"),
    JSON.stringify({
      first: [alpha],
      second: [alpha, beta],
      absent: [requirement("other.mjs", "beta")],
    }),
  );
  await mkdir(path.join(root, "dist/test"), { recursive: true });
  await writeFile(
    path.join(root, "dist/test/optional.test.js"),
    "const {test}=require('node:test');test('optional',{skip:true},()=>{});",
  );
  const cli = (...selection: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/verify.mjs"), ...selection],
      {
        encoding: "utf8",
        env: environment,
        timeout: 10000,
      },
    );
  await writeFile(path.join(root, "dist/test/optional.test.js"), "");
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "dist/test/optional.test.js"));
  await writeFile(marker, "");
  assert.equal(cli("--full-suite", "first", "second").status, 1);
  assert.equal(
    await readFile(marker, "utf8"),
    "",
    "an empty full suite cannot execute or pass a profile",
  );
  await writeFile(
    path.join(root, "dist/test/optional.test.js"),
    "const {test}=require('node:test');test('optional',{skip:true},()=>{});",
  );
  const single = cli("first");
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).profile, "first");
  assert.equal(Object.hasOwn(JSON.parse(single.stdout), "profiles"), false);
  const batch = cli("first", "second");
  assert.equal(batch.status, 0, batch.stderr);
  assert.equal(JSON.parse(batch.stdout).required, 2);
  assert.equal(cli("first", "absent").status, 1);
  const suite = cli("--full-suite", "first", "second");
  assert.equal(suite.status, 0, suite.stderr);
  assert.equal(JSON.parse(suite.stdout).optionalSkipped, 1);
  assert.equal(JSON.parse(suite.stdout).required, 2);
  for (const selection of [
    [],
    ["--full-suite"],
    ["unknown"],
    ["first", "unknown"],
    ["first", "first"],
  ]) {
    await writeFile(marker, "");
    assert.notEqual(cli(...selection).status, 0);
    assert.equal(await readFile(marker, "utf8"), "");
  }
});
