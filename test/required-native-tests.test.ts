import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { access, mkdir, writeFile, realpath } from "node:fs/promises";
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

type TerminalReceipt = {
  complete: boolean;
  passed: number;
  required: number;
  problems: { name: string; reason: string }[];
  ledger: {
    terminalEventCount: number;
    truncated: boolean;
    files: {
      id: string;
      before: { state: string; sha256?: string; code?: string };
      after: { state: string; sha256?: string; code?: string };
      stable: boolean;
    }[];
    events: {
      sequence: number;
      fileId: string | null;
      name: string;
      nameTruncated: boolean;
      kind: string;
      outcome: string;
      required: boolean;
    }[];
    cases: {
      fileId: string;
      name: string;
      outcome: string;
      terminalSequences: number[];
    }[];
  };
};
async function ledgerFixture(t: import("node:test").TestContext) {
  const root = await fixture(t, {
    "ledger-runner.mjs":
      "const {runRequiredTests}=await import(process.argv[2]);console.log(JSON.stringify(await runRequiredTests(JSON.parse(process.argv[3]),JSON.parse(process.argv[4]))));",
    "pass.test.mjs":
      "import {test} from 'node:test';test('original-required',()=>{});test('original-extra',()=>{});",
    "skip.test.mjs":
      "import {test} from 'node:test';test('original-required',{skip:'unavailable'},()=>{});",
    "todo.test.mjs":
      "import {test} from 'node:test';test('original-required',{todo:true},()=>{});",
    "fail.test.mjs":
      "import {test} from 'node:test';test('original-required',()=>{throw new Error('original-failure')});",
    "duplicate.test.mjs":
      "import {test} from 'node:test';test('original-required',()=>{});test('original-required',()=>{});",
    "other.test.mjs":
      "import {test} from 'node:test';test('original-other',()=>{});",
    "changed.test.mjs":
      "import {test} from 'node:test';import {writeFile} from 'node:fs/promises';test('original-required',async()=>{await writeFile(new URL(import.meta.url),'// original source changed\\n')});",
    "removed.test.mjs":
      "import {test} from 'node:test';import {unlink} from 'node:fs/promises';test('original-required',async()=>{await unlink(new URL(import.meta.url))});",
    "timeout.test.mjs":
      "import {test} from 'node:test';test('original-required',async()=>{await new Promise(resolve=>setTimeout(resolve,5000))});",
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const execute = (
    requirements: { file: string; name: string }[],
    options: {
      timeoutMs?: number;
      maxTerminalEvents?: number;
      isolatedCaseWorkers?: number;
      additionalFiles?: string[];
    } = {},
  ) => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "ledger-runner.mjs"),
        new URL("../../scripts/required-test-evidence.mjs", import.meta.url)
          .href,
        JSON.stringify(requirements),
        JSON.stringify(options),
      ],
      { encoding: "utf8", timeout: 15000, env },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as TerminalReceipt;
  };
  const required = (file: string) => ({
    file: path.join(root, file),
    name: "original-required",
  });
  return { root, execute, required };
}

test("native acceptance ledger binds every reached outcome and missing required case", async (t) => {
  const { root, execute, required } = await ledgerFixture(t);
  const passed = execute([required("pass.test.mjs")]);
  assert.equal(passed.complete, true, JSON.stringify(passed));
  assert.equal(passed.ledger.truncated, false);
  assert.equal(passed.ledger.terminalEventCount, passed.ledger.events.length);
  assert.deepEqual(passed.ledger.cases, [
    {
      fileId: "file-1",
      name: "original-required",
      outcome: "passed",
      terminalSequences: [1],
    },
  ]);
  assert.deepEqual(
    passed.ledger.events.map(({ name, outcome, required }) => ({
      name,
      outcome,
      required,
    })),
    [
      { name: "original-required", outcome: "passed", required: true },
      { name: "original-extra", outcome: "passed", required: false },
    ],
  );
  assert.equal(passed.ledger.files[0]!.stable, true);
  assert.match(passed.ledger.files[0]!.before.sha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    passed.ledger.files[0]!.before,
    passed.ledger.files[0]!.after,
  );
  assert.equal(JSON.stringify(passed.ledger).includes(root), false);
  const outcomes: Array<[string, string]> = [
    ["skip.test.mjs", "skipped"],
    ["todo.test.mjs", "todo"],
    ["fail.test.mjs", "failed"],
    ["duplicate.test.mjs", "duplicate"],
  ];
  for (const [file, outcome] of outcomes) {
    const receipt = execute([required(file)]);
    assert.equal(receipt.complete, false, file);
    assert.equal(receipt.ledger.cases[0]!.outcome, outcome, file);
    assert.equal(
      receipt.ledger.cases[0]!.terminalSequences.length,
      outcome === "duplicate" ? 2 : 1,
      file,
    );
  }
  const missing = execute([
    required("other.test.mjs"),
    { file: path.join(root, "pass.test.mjs"), name: "original-extra" },
  ]);
  assert.equal(missing.complete, false);
  assert.deepEqual(
    missing.ledger.cases.map(({ outcome }) => outcome),
    ["not-observed", "passed"],
  );
  assert.deepEqual(missing.ledger.cases[0]!.terminalSequences, []);
  assert.equal(
    missing.ledger.events.find((event) => event.name === "original-required")!
      .required,
    false,
  );
  assert.equal(new Set(missing.ledger.files.map((file) => file.id)).size, 2);
});

test("native acceptance ledger rejects truncation and changed or unavailable test bytes", async (t) => {
  const { execute, required } = await ledgerFixture(t);
  const capped = execute([required("pass.test.mjs")], { maxTerminalEvents: 1 });
  assert.equal(capped.complete, false);
  assert.equal(capped.ledger.events.length, 1);
  assert.equal(capped.ledger.terminalEventCount, 2);
  assert.equal(capped.ledger.truncated, true);
  assert.equal(capped.ledger.cases[0]!.outcome, "passed");
  assert.ok(
    capped.problems.some(
      (problem) => problem.reason === "terminal-ledger-limit",
    ),
  );
  const changed = execute([required("changed.test.mjs")]);
  assert.equal(changed.passed, 1);
  assert.equal(changed.ledger.cases[0]!.outcome, "passed");
  assert.equal(changed.complete, false);
  assert.equal(changed.ledger.files[0]!.stable, false);
  assert.notEqual(
    changed.ledger.files[0]!.before.sha256,
    changed.ledger.files[0]!.after.sha256,
  );
  assert.ok(
    changed.problems.some(
      (problem) => problem.reason === "required-file-unavailable-or-changed",
    ),
  );
  const removed = execute([required("removed.test.mjs")]);
  assert.equal(removed.ledger.cases[0]!.outcome, "passed");
  assert.equal(removed.complete, false);
  assert.equal(removed.ledger.files[0]!.after.state, "unavailable");
  assert.equal(removed.ledger.files[0]!.after.code, "ENOENT");
  const absent = execute([required("absent.test.mjs")]);
  assert.equal(absent.complete, false);
  assert.equal(absent.ledger.events.length, 0);
  assert.equal(absent.ledger.cases[0]!.outcome, "not-observed");
  assert.equal(absent.ledger.files[0]!.before.state, "unavailable");
});

test("native acceptance ledger retains timeout failures and unknown required outcomes", async (t) => {
  const { execute, required } = await ledgerFixture(t);
  const result = execute([required("timeout.test.mjs")], { timeoutMs: 1000 });
  assert.equal(result.complete, false);
  assert.equal(result.passed, 0);
  assert.ok(result.ledger.events.some((event) => event.outcome === "failed"));
  assert.notEqual(result.ledger.cases[0]!.outcome, "passed");
  assert.ok(
    result.ledger.events.every(
      (event) => event.kind !== "suite" || !event.required,
    ),
  );
  assert.equal(result.ledger.truncated, false);
  assert.equal(result.ledger.files[0]!.stable, true);
});

test("native acceptance ledger preflights every selected file within exact byte limits", async (t) => {
  const { root, execute, required } = await ledgerFixture(t);
  const limit = 4 * 1024 * 1024;
  const source =
    "import {test} from 'node:test';test('original-required',()=>{});\n//";
  await writeFile(
    path.join(root, "bounded.test.mjs"),
    source + "x".repeat(limit - Buffer.byteLength(source)),
  );
  const bounded = execute([required("bounded.test.mjs")]);
  assert.equal(bounded.complete, true, JSON.stringify(bounded));
  assert.equal(bounded.ledger.cases[0]!.outcome, "passed");
  await writeFile(
    path.join(root, "oversize.test.mjs"),
    source + "x".repeat(limit + 1 - Buffer.byteLength(source)),
  );
  const oversize = execute([required("oversize.test.mjs")]);
  assert.equal(oversize.complete, false);
  assert.equal(oversize.ledger.events.length, 0);
  assert.equal(oversize.ledger.cases[0]!.outcome, "not-observed");
  assert.equal(oversize.ledger.files[0]!.before.code, "file-byte-limit");
  await mkdir(path.join(root, "directory.test.mjs"));
  const directory = execute([required("directory.test.mjs")]);
  assert.equal(directory.complete, false);
  assert.equal(directory.ledger.files[0]!.before.code, "not-regular");
  assert.equal(directory.ledger.events.length, 0);
  await writeFile(
    path.join(root, "marker.test.mjs"),
    "import {test} from 'node:test';import {writeFile} from 'node:fs/promises';test('original-required',async()=>writeFile(new URL('executed',import.meta.url),'yes'));",
  );
  const allTargets = execute([
    required("marker.test.mjs"),
    required("missing.test.mjs"),
  ]);
  assert.equal(allTargets.complete, false);
  assert.deepEqual(
    allTargets.ledger.cases.map(({ outcome }) => outcome),
    ["not-observed", "not-observed"],
  );
  assert.equal(allTargets.ledger.events.length, 0);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await writeFile(
    path.join(root, "long-name.test.mjs"),
    "import {test} from 'node:test';test('original-required',()=>{});test('x'.repeat(513),()=>{});",
  );
  const clipped = execute([required("long-name.test.mjs")]);
  assert.equal(clipped.complete, false);
  assert.equal(clipped.ledger.cases[0]!.outcome, "passed");
  assert.equal(clipped.ledger.events[1]!.name.length, 512);
  assert.equal(clipped.ledger.events[1]!.nameTruncated, true);
  assert.ok(
    clipped.problems.some(
      (problem) => problem.reason === "terminal-name-truncated",
    ),
  );
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
  const parsed = JSON.parse(report.stdout);
  assert.deepEqual(
    {
      profiles: parsed.profiles,
      passed: parsed.passed,
      required: parsed.required,
      problems: parsed.problems,
      complete: parsed.complete,
    },
    {
      profiles: [
        { profile: "first", required: 1 },
        { profile: "second", required: 2 },
      ],
      passed: 3,
      required: 2,
      problems: [],
      complete: true,
    },
  );
  assert.equal(await readFile(marker, "utf8"), "shared\n");
  assert.deepEqual(
    parsed.ledger.cases.map((item: { outcome: string }) => item.outcome),
    ["passed", "passed"],
  );
  assert.equal(parsed.ledger.events.length, 3);
  assert.equal(parsed.ledger.files.length, 1);
  assert.equal(parsed.ledger.files[0].stable, true);
  assert.equal(JSON.stringify(parsed.ledger).includes(root), false);
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

  // Full-suite files retain the same byte-stability and ledger bounds.
  await writeFile(
    path.join(root, "changed.mjs"),
    "import {appendFileSync} from 'node:fs';import {test} from 'node:test';test('optional',()=>appendFileSync(new URL(import.meta.url),'// changed\\n'));",
  );
  const changed = invoke({ first: [alpha], second: [beta] }, undefined, {
    additionalFiles: [path.join(root, "changed.mjs")],
  });
  assert.equal(changed.status, 0, changed.stderr);
  const changedReport = JSON.parse(changed.stdout);
  assert.equal(changedReport.complete, false);
  assert.equal(
    changedReport.ledger.files.find((file: { stable: boolean }) => !file.stable)
      ?.stable,
    false,
  );
  assert.ok(
    changedReport.problems.some(
      (problem: { reason: string }) =>
        problem.reason === "required-file-unavailable-or-changed",
    ),
  );
  const capped = invoke({ first: [alpha], second: [beta] }, undefined, {
    additionalFiles: [path.join(root, "skip.mjs")],
    maxTerminalEvents: 1,
  });
  assert.equal(capped.status, 0, capped.stderr);
  assert.equal(JSON.parse(capped.stdout).complete, false);
  assert.equal(JSON.parse(capped.stdout).ledger.truncated, true);
  await writeFile(marker, "");
  assert.notEqual(
    invoke({ first: [alpha], second: [beta] }, undefined, {
      additionalFiles: [path.join(root, "absent.mjs")],
    }).status,
    0,
  );
  assert.equal(
    await readFile(marker, "utf8"),
    "",
    "unavailable full-suite files prevent execution",
  );

  // Exercise CLI exit status and keep the single-profile acceptance format.
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await writeFile(
    path.join(root, "dist/src/original.js"),
    "export const original = true;\n",
  );
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts/compiled-engine-evidence.mjs"),
    await readFile(
      new URL("../../scripts/compiled-engine-evidence.mjs", import.meta.url),
    ),
  );
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
      "ruby-tools-lifecycle": [alpha, beta],
      "ruby-tools-rubocop": [alpha],
      "attempt-archives": [
        requirement("isolated-profile.mjs", "alpha"),
        requirement("isolated-profile.mjs", "beta"),
      ],
      "consumer-impact": [
        requirement("isolated-profile.mjs", "alpha"),
        requirement("isolated-profile.mjs", "beta"),
      ],
    }),
  );
  await mkdir(path.join(root, "dist/test"), { recursive: true });
  await writeFile(
    path.join(root, "dist/test/optional.test.js"),
    "const {test}=require('node:test');test('optional',{skip:true},()=>{});",
  );
  await writeFile(
    path.join(root, "isolated-profile.mjs"),
    "import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';let calls=0;for(const name of ['alpha','beta'])test(name,()=>{assert.equal(++calls,1,'each selected callback must have fresh module state');appendFileSync(process.env.BATCH_MARKER,JSON.stringify({pid:process.pid,name})+'\\n')});test('extra',()=>assert.fail('unselected callback must not execute'));",
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
  assert.equal(JSON.parse(single.stdout).timeoutMs, 120000);
  assert.equal(Object.hasOwn(JSON.parse(single.stdout), "profiles"), false);
  const batch = cli("first", "second");
  assert.equal(batch.status, 0, batch.stderr);
  assert.equal(JSON.parse(batch.stdout).required, 2);
  assert.equal(JSON.parse(batch.stdout).timeoutMs, 120000);
  const rubyLifecycle = cli("ruby-tools-lifecycle");
  assert.equal(rubyLifecycle.status, 0, rubyLifecycle.stderr);
  assert.equal(JSON.parse(rubyLifecycle.stdout).timeoutMs, 600000);
  assert.equal(JSON.parse(rubyLifecycle.stdout).required, 2);
  assert.equal(
    JSON.parse(rubyLifecycle.stdout).passed,
    3,
    "both required callbacks and the unlisted shared-file callback still run",
  );
  const rubyRubocop = cli("ruby-tools-rubocop");
  assert.equal(rubyRubocop.status, 0, rubyRubocop.stderr);
  assert.equal(JSON.parse(rubyRubocop.stdout).timeoutMs, 300000);
  for (const profile of ["consumer-impact", "attempt-archives"]) {
    await writeFile(marker, "");
    const whole = cli(profile);
    assert.equal(whole.status, 0, whole.stdout + whole.stderr);
    const wholeReport = JSON.parse(whole.stdout);
    assert.equal(wholeReport.timeoutMs, 600000);
    assert.equal(wholeReport.requiredCaseWorkerLimit, 1);
    assert.equal(wholeReport.required, 2);
    assert.equal(wholeReport.passed, 2);
    const executions: { pid: number; name: string }[] = (
      await readFile(marker, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(executions.map((row) => row.name).sort(), [
      "alpha",
      "beta",
    ]);
    assert.equal(
      new Set(executions.map((row) => row.pid)).size,
      2,
      "whole-profile callbacks must execute in separate real processes",
    );
  }
  assert.equal(cli("first", "absent").status, 1);
  const suite = cli("--full-suite", "first", "second");
  assert.equal(suite.status, 0, suite.stderr);
  assert.equal(JSON.parse(suite.stdout).optionalSkipped, 1);
  assert.equal(JSON.parse(suite.stdout).required, 2);
  assert.equal(JSON.parse(suite.stdout).timeoutMs, 600000);
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

test("required profile union exceeds a single manifest while retaining bounded acceptance", async (t) => {
  const root = await fixture(t, {
    "batch.mjs":
      "import {readFileSync} from 'node:fs';const {runRequiredProfiles}=await import(process.argv[2]);const {profiles,options}=JSON.parse(readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify(await runRequiredProfiles(profiles,Object.keys(profiles),options)));",
    "many.mjs":
      "import {test} from 'node:test';import {writeFileSync} from 'node:fs';writeFileSync(new URL('executed',import.meta.url),'yes');for(let i=0;i<4096;i++)test('case-'+i,()=>{});",
  });
  const file = path.join(root, "many.mjs");
  const requirements = Array.from({ length: 4097 }, (_, i) => ({
    file,
    name: "case-" + i,
  }));
  const helper = new URL(
    "../../scripts/required-test-evidence.mjs",
    import.meta.url,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const invoke = (profiles: Record<string, unknown>, options = {}) => {
    const manifest = path.join(root, "invocation.json");
    writeFileSync(manifest, JSON.stringify({ profiles, options }));
    return spawnSync(
      process.execPath,
      [path.join(root, "batch.mjs"), helper.href, manifest],
      { encoding: "utf8", env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
  };
  const profiles = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      "profile-" + i,
      requirements.slice(i * 256, (i + 1) * 256),
    ]),
  );
  const valid = invoke(profiles);
  assert.equal(valid.error, undefined, valid.error?.message ?? "");
  assert.equal(valid.status, 0, valid.stderr);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.required, 4096);
  assert.equal(report.passed, 4096);
  assert.equal(report.ledger.terminalEventCount, 4096);
  assert.equal(report.ledger.cases.length, 4096);
  assert.equal(
    new Set(
      report.ledger.cases.flatMap(
        (item: { terminalSequences: number[] }) => item.terminalSequences,
      ),
    ).size,
    4096,
  );
  assert.equal(report.ledger.truncated, false);
  assert.equal(report.ledger.maxTerminalEvents, 4096);
  const capped = invoke(profiles, { maxTerminalEvents: 4095 });
  assert.equal(capped.status, 0, capped.stderr);
  const incomplete = JSON.parse(capped.stdout);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.ledger.terminalEventCount, 4096);
  assert.equal(incomplete.ledger.events.length, 4095);
  assert.equal(incomplete.ledger.truncated, true);
  assert.ok(
    incomplete.problems.some(
      (problem: { reason: string }) =>
        problem.reason === "terminal-ledger-limit",
    ),
  );
  const { unlink } = await import("node:fs/promises");
  await unlink(path.join(root, "executed"));
  const oversized = invoke(
    { one: requirements.slice(0, 1) },
    { maxTerminalEvents: 4097 },
  );
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /Required terminal ledger must be bounded/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  assert.notEqual(invoke({ tooLarge: requirements.slice(0, 257) }).status, 0);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  assert.notEqual(
    invoke(
      Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [
          "profile-" + i,
          requirements.slice(i * 256, (i + 1) * 256),
        ]),
      ),
    ).status,
    0,
  );
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
});

test("native acceptance accepts cumulative callbacks within file budgets and rejects excessive limits", async (t) => {
  const { root, execute } = await ledgerFixture(t);
  const file = path.join(root, "cumulative.test.mjs");
  await writeFile(
    file,
    "import {test} from 'node:test';import {setTimeout} from 'node:timers/promises';for(let i=0;i<3;i++)test('original-'+i,{timeout:1000},async()=>{await setTimeout(700)});",
  );
  const requirements = Array.from({ length: 3 }, (_, i) => ({
    file,
    name: "original-" + i,
  }));
  const complete = execute(requirements, { timeoutMs: 4000 });
  assert.equal(complete.complete, true, JSON.stringify(complete));
  assert.equal(complete.passed, 3);
  assert.deepEqual(
    complete.ledger.cases.map((item) => item.outcome),
    ["passed", "passed", "passed"],
  );
  const boundedFile = path.join(root, "bounded-callback.test.mjs");
  await writeFile(
    boundedFile,
    "import {test} from 'node:test';import {setTimeout} from 'node:timers/promises';test('original-bound',{timeout:300},async()=>{await setTimeout(3000)});",
  );
  const bounded = execute([{ file: boundedFile, name: "original-bound" }], {
    timeoutMs: 4000,
  });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.ledger.cases[0]!.outcome, "failed");
  assert.ok(
    bounded.problems.some(
      (problem) =>
        problem.name === "original-bound" && problem.reason === "failed",
    ),
  );
  const ceiling = execute(requirements, { timeoutMs: 600000 });
  assert.equal(ceiling.complete, true, JSON.stringify(ceiling));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const rejected = spawnSync(
    process.execPath,
    [
      path.join(root, "ledger-runner.mjs"),
      new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href,
      JSON.stringify(requirements),
      JSON.stringify({ timeoutMs: 600001 }),
    ],
    { encoding: "utf8", timeout: 10000, env },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /Required test harness timeout must be bounded/,
  );
  assert.equal(rejected.stdout, "");
});

test("required full-suite files run in parallel within the shared worker ceiling and retain every outcome", async (t) => {
  const { availableParallelism } = await import("node:os"),
    { readFile } = await import("node:fs/promises");
  const worker = `import{test}from'node:test';import{readFile,writeFile,rename,mkdir,rm,access}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';import path from'node:path';const directory=process.env.ORIGINAL_WORKER_DIRECTORY;async function update(change){let locked=false;for(let i=0;i<1000;i++){try{await mkdir(path.join(directory,'lock'));locked=true;break;}catch(error){if(error.code!=='EEXIST')throw error;await delay(2)}}if(!locked)throw Error('Original counter lock exhausted');try{const file=path.join(directory,'counts.json'),counts=JSON.parse(await readFile(file,'utf8'));change(counts);counts.maximum=Math.max(counts.maximum,counts.active);await writeFile(path.join(directory,'counts.pending'),JSON.stringify(counts));await rename(path.join(directory,'counts.pending'),file);if(counts.active>=2)await writeFile(path.join(directory,'parallel.ready'),'reached');}finally{await rm(path.join(directory,'lock'),{recursive:true});}}test('original-worker-'+process.env.ORIGINAL_WORKER_NAME,async()=>{await update(c=>c.active++);try{if(process.env.ORIGINAL_EXPECT_OVERLAP==='1')for(let i=0;i<500;i++){try{await access(path.join(directory,'parallel.ready'));break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(2)}}await delay(1000);}finally{await update(c=>{c.active--;c.completed++;});}});`;
  const files = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      "worker" + i + ".mjs",
      worker.replace(
        "process.env.ORIGINAL_WORKER_NAME",
        JSON.stringify(String(i)),
      ),
    ]),
  );
  const root = await fixture(t, {
    ...files,
    "counts.json": JSON.stringify({ active: 0, maximum: 0, completed: 0 }),
    "runner.mjs":
      "const {runRequiredTests}=await import(process.argv[2]);console.log(JSON.stringify(await runRequiredTests(JSON.parse(process.argv[3]),{additionalFiles:JSON.parse(process.argv[4]),timeoutMs:20000})));",
  });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ORIGINAL_WORKER_DIRECTORY: root,
    ORIGINAL_EXPECT_OVERLAP: availableParallelism() >= 2 ? "1" : "0",
  };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "runner.mjs"),
      new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href,
      JSON.stringify([
        { file: path.join(root, "worker0.mjs"), name: "original-worker-0" },
      ]),
      JSON.stringify(
        Array.from({ length: 8 }, (_, i) =>
          path.join(root, "worker" + (i + 1) + ".mjs"),
        ),
      ),
    ],
    { env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
  );
  assert.equal(
    result.error,
    undefined,
    result.error?.message ?? "Original worker process failed",
  );
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.complete, true, JSON.stringify(receipt.problems));
  assert.equal(receipt.passed, 9);
  assert.equal(receipt.required, 1);
  assert.equal(receipt.optionalSkipped, 0);
  assert.equal(receipt.files, 9);
  assert.equal(receipt.ledger.terminalEventCount, 9);
  assert.equal(receipt.ledger.files.length, 9);
  assert.ok(receipt.ledger.files.every((f: { stable: boolean }) => f.stable));
  assert.equal(receipt.ledger.cases[0].outcome, "passed");
  const counts = JSON.parse(
    await readFile(path.join(root, "counts.json"), "utf8"),
  );
  assert.equal(counts.active, 0, "Every worker must release the active slot");
  assert.equal(counts.completed, 9, "Every selected file must run");
  assert.ok(
    counts.maximum <= 4,
    "Actual concurrently executing files exceeded the shared ceiling: " +
      counts.maximum,
  );
  if (availableParallelism() >= 2)
    assert.ok(counts.maximum >= 2, "Full-suite files were serialized");
  else assert.equal(counts.maximum, 1);
});

test("full-suite gives the exact JavaScript native file an exclusive process while preserving adjacent files and unlisted callbacks", async (t) => {
  const { readFile, cp } = await import("node:fs/promises"),
    { availableParallelism, tmpdir } = await import("node:os");
  const worker = (name: string) =>
    `import {test} from 'node:test';import {appendFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {setTimeout as delay} from 'node:timers/promises';test(${JSON.stringify(name)},async()=>{appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'start ${name}\\n');await delay(250);appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'end ${name}\\n');${name === "adjacent" ? "writeFileSync(process.env.ORIGINAL_ADJACENT_NAMESPACE,tmpdir());" : ""}});`;
  const root = await fixture(t, {
    ...Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `dist/test/worker${i}.mjs`,
        worker("worker" + i),
      ]),
    ),
    "dist/test/gate-javascript-extensions-extra.test.js": worker("adjacent"),
    "dist/test/gate-javascript-extensions.test.js": `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';test('original-exclusive',()=>{const log=readFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'utf8').trim().split('\\n');assert.equal(log.filter(l=>l.startsWith('end ')).length,7,'Every shared file must finish before native admission');assert.equal(log.filter(l=>l.startsWith('start ')).length,7);writeFileSync(process.env.ORIGINAL_EXCLUSIVE_NAMESPACE,tmpdir());appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'exclusive\\n');});test('original-unlisted',()=>appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'unlisted\\n'));`,
    "runner.mjs":
      "const {runRequiredTests}=await import('./scripts/required-test-evidence.mjs');console.log(JSON.stringify(await runRequiredTests(JSON.parse(process.argv[2]),{timeoutMs:20000,additionalFiles:JSON.parse(process.argv[3])})));",
    "events.log": "",
    "package.json": '{"type":"module"}',
  });
  await mkdir(path.join(root, "scripts"));
  await cp(
    new URL("../../scripts/required-test-evidence.mjs", import.meta.url),
    path.join(root, "scripts/required-test-evidence.mjs"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORIGINAL_EXCLUSIVE_LOG: path.join(root, "events.log"),
    ORIGINAL_EXCLUSIVE_NAMESPACE: path.join(root, "exclusive.namespace"),
    ORIGINAL_ADJACENT_NAMESPACE: path.join(root, "adjacent.namespace"),
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "runner.mjs"),
      JSON.stringify([
        { file: path.join(root, "dist/test/worker0.mjs"), name: "worker0" },
        {
          file: path.join(root, "dist/test/gate-javascript-extensions.test.js"),
          name: "original-exclusive",
        },
      ]),
      JSON.stringify([
        ...Array.from({ length: 5 }, (_, i) =>
          path.join(root, `dist/test/worker${i + 1}.mjs`),
        ),
        path.join(root, "dist/test/gate-javascript-extensions-extra.test.js"),
      ]),
    ],
    { env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(
    result.error,
    undefined,
    result.error?.message ?? "Exclusive fixture failed",
  );
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.complete, true, JSON.stringify(receipt.problems));
  assert.equal(receipt.exclusiveFullSuiteFileCount, 1);
  assert.equal(receipt.passed, 9);
  assert.equal(receipt.required, 2);
  assert.equal(receipt.optionalSkipped, 0);
  assert.equal(receipt.files, 8);
  assert.equal(receipt.ledger.terminalEventCount, 9);
  assert.equal(receipt.ledger.files.length, 8);
  assert.ok(
    receipt.ledger.files.every((file: { stable: boolean }) => file.stable),
  );
  assert.ok(
    receipt.ledger.cases.every(
      (entry: { outcome: string }) => entry.outcome === "passed",
    ),
  );
  const events = (await readFile(path.join(root, "events.log"), "utf8"))
    .trim()
    .split("\n");
  assert.deepEqual(events.slice(-2), ["exclusive", "unlisted"]);
  let active = 0,
    maximum = 0;
  for (const event of events.slice(0, -2)) {
    active += event.startsWith("start ") ? 1 : -1;
    assert.ok(active >= 0);
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  assert.ok(maximum <= Math.min(4, availableParallelism()));
  if (availableParallelism() >= 2)
    assert.ok(maximum >= 2, "Shared files must keep parallel execution");
  assert.equal(
    await readFile(path.join(root, "adjacent.namespace"), "utf8"),
    tmpdir(),
    "An adjacent filename must stay in the shared wave",
  );
  const exclusiveTemporary = await readFile(
    path.join(root, "exclusive.namespace"),
    "utf8",
  );
  assert.notEqual(exclusiveTemporary, tmpdir());
  await assert.rejects(access(exclusiveTemporary), { code: "ENOENT" });
});

test("full-suite gives the exact Tasks matrix file an exclusive process while preserving adjacent files and unlisted callbacks", async (t) => {
  const { readFile, cp } = await import("node:fs/promises"),
    { availableParallelism, tmpdir } = await import("node:os");
  const worker = (name: string) =>
    `import {test} from 'node:test';import {appendFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {setTimeout as delay} from 'node:timers/promises';test(${JSON.stringify(name)},async()=>{appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'start ${name}\\n');await delay(250);appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'end ${name}\\n');${name === "adjacent" ? "writeFileSync(process.env.ORIGINAL_ADJACENT_NAMESPACE,tmpdir());" : ""}});`;
  const root = await fixture(t, {
    ...Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `dist/test/worker${i}.mjs`,
        worker("worker" + i),
      ]),
    ),
    "dist/test/gate-tasks-matrix-extra.test.js": worker("adjacent"),
    "dist/test/gate-tasks-matrix.test.js": `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';test('original-exclusive',()=>{const log=readFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'utf8').trim().split('\\n');assert.equal(log.filter(l=>l.startsWith('end ')).length,7,'Every shared file must finish before native admission');assert.equal(log.filter(l=>l.startsWith('start ')).length,7);writeFileSync(process.env.ORIGINAL_EXCLUSIVE_NAMESPACE,tmpdir());appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'exclusive\\n');});test('original-unlisted',()=>appendFileSync(process.env.ORIGINAL_EXCLUSIVE_LOG,'unlisted\\n'));`,
    "runner.mjs":
      "const {runRequiredTests}=await import('./scripts/required-test-evidence.mjs');console.log(JSON.stringify(await runRequiredTests(JSON.parse(process.argv[2]),{timeoutMs:20000,additionalFiles:JSON.parse(process.argv[3])})));",
    "events.log": "",
    "package.json": '{"type":"module"}',
  });
  await mkdir(path.join(root, "scripts"));
  await cp(
    new URL("../../scripts/required-test-evidence.mjs", import.meta.url),
    path.join(root, "scripts/required-test-evidence.mjs"),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORIGINAL_EXCLUSIVE_LOG: path.join(root, "events.log"),
    ORIGINAL_EXCLUSIVE_NAMESPACE: path.join(root, "exclusive.namespace"),
    ORIGINAL_ADJACENT_NAMESPACE: path.join(root, "adjacent.namespace"),
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "runner.mjs"),
      JSON.stringify([
        { file: path.join(root, "dist/test/worker0.mjs"), name: "worker0" },
        {
          file: path.join(root, "dist/test/gate-tasks-matrix.test.js"),
          name: "original-exclusive",
        },
      ]),
      JSON.stringify([
        ...Array.from({ length: 5 }, (_, i) =>
          path.join(root, `dist/test/worker${i + 1}.mjs`),
        ),
        path.join(root, "dist/test/gate-tasks-matrix-extra.test.js"),
      ]),
    ],
    { env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(
    result.error,
    undefined,
    result.error?.message ?? "Exclusive fixture failed",
  );
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.complete, true, JSON.stringify(receipt.problems));
  assert.equal(receipt.exclusiveFullSuiteFileCount, 1);
  assert.equal(receipt.passed, 9);
  assert.equal(receipt.required, 2);
  assert.equal(receipt.optionalSkipped, 0);
  assert.equal(receipt.files, 8);
  assert.equal(receipt.ledger.terminalEventCount, 9);
  assert.equal(receipt.ledger.files.length, 8);
  assert.ok(
    receipt.ledger.files.every((file: { stable: boolean }) => file.stable),
  );
  assert.ok(
    receipt.ledger.cases.every(
      (entry: { outcome: string }) => entry.outcome === "passed",
    ),
  );
  const events = (await readFile(path.join(root, "events.log"), "utf8"))
    .trim()
    .split("\n");
  assert.deepEqual(events.slice(-2), ["exclusive", "unlisted"]);
  let active = 0,
    maximum = 0;
  for (const event of events.slice(0, -2)) {
    active += event.startsWith("start ") ? 1 : -1;
    assert.ok(active >= 0);
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0);
  assert.ok(maximum <= Math.min(4, availableParallelism()));
  if (availableParallelism() >= 2)
    assert.ok(maximum >= 2, "Shared files must keep parallel execution");
  assert.equal(
    await readFile(path.join(root, "adjacent.namespace"), "utf8"),
    tmpdir(),
    "An adjacent filename must stay in the shared wave",
  );
  const exclusiveTemporary = await readFile(
    path.join(root, "exclusive.namespace"),
    "utf8",
  );
  assert.notEqual(exclusiveTemporary, tmpdir());
  await assert.rejects(access(exclusiveTemporary), { code: "ENOENT" });
});

test("named native acceptance gives each exact callback a fresh bounded process budget", async (t) => {
  const { root, execute } = await ledgerFixture(t);
  const file = path.join(root, "independent.test.mjs");
  await writeFile(
    file,
    `import {test} from 'node:test';import assert from 'node:assert/strict';import {setTimeout} from 'node:timers/promises';import {writeFileSync} from 'node:fs';let calls=0;for(let i=0;i<3;i++)test('original ['+i+']',async()=>{assert.equal(++calls,1);writeFileSync(new URL('pid-'+i,import.meta.url),JSON.stringify({pid:process.pid,temporary:process.getBuiltinModule('node:os').tmpdir()}));await setTimeout(600)});test('original [0] suffix',()=>{throw Error('Unexpected prefix match')});test('original 0',()=>{throw Error('Unescaped selector')});`,
  );
  const expected = Array.from({ length: 3 }, (_, i) => ({
    file,
    name: "original [" + i + "]",
  }));
  const receipt = execute(expected, {
    timeoutMs: 1200,
    isolatedCaseWorkers: 2,
  });
  assert.equal(receipt.complete, true, JSON.stringify(receipt));
  assert.equal(receipt.passed, 3);
  assert.equal(receipt.required, 3);
  assert.equal(receipt.ledger.terminalEventCount, 3);
  assert.deepEqual(
    receipt.ledger.cases.map((item) => item.outcome),
    ["passed", "passed", "passed"],
  );
  assert.ok(receipt.ledger.files.every((file) => file.stable));
  const { readFile } = await import("node:fs/promises");
  const pids = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      readFile(path.join(root, "pid-" + i), "utf8"),
    ),
  );
  const witnesses = pids.map(
    (value) => JSON.parse(value) as { pid: number; temporary: string },
  );
  assert.equal(
    new Set(witnesses.map((value) => value.temporary)).size,
    3,
    "Each native case needs its own temporary namespace",
  );
  for (const value of witnesses)
    await assert.rejects(access(value.temporary), { code: "ENOENT" });
  assert.equal(
    new Set(witnesses.map((value) => value.pid)).size,
    3,
    "Every selected callback must run in a different process",
  );
  assert.ok(witnesses.every((value) => value.pid !== process.pid));
});

test("named native acceptance still rejects skipped missing duplicate changed and timed-out cases", async (t) => {
  const { execute, required } = await ledgerFixture(t);
  for (const file of [
    "skip.test.mjs",
    "todo.test.mjs",
    "fail.test.mjs",
    "duplicate.test.mjs",
    "other.test.mjs",
    "changed.test.mjs",
    "removed.test.mjs",
    "missing.test.mjs",
    "timeout.test.mjs",
  ]) {
    const result = execute([required(file)], {
      isolatedCaseWorkers: 2,
      timeoutMs: 500,
    });
    assert.equal(result.complete, false, file);
    assert.ok(result.problems.length > 0, file);
  }
  const capped = execute(
    [required("pass.test.mjs"), required("other.test.mjs")],
    { isolatedCaseWorkers: 2, maxTerminalEvents: 1 },
  );
  assert.equal(capped.complete, false);
  assert.equal(capped.ledger.cases[1]!.outcome, "not-observed");
});

test("named native acceptance executes overlapping callbacks within two worker slots", async (t) => {
  const { root, execute } = await ledgerFixture(t);
  const { availableParallelism } = await import("node:os");
  const { readFile } = await import("node:fs/promises");
  const file = path.join(root, "workers.test.mjs");
  await writeFile(
    file,
    `import {test} from 'node:test';import {appendFileSync,readFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';const log=new URL('workers.log',import.meta.url);for(let i=0;i<4;i++)test('original-worker-'+i,async()=>{appendFileSync(log,'start '+i+'\\n');try{if(${availableParallelism() >= 2}){const deadline=Date.now()+2000;while(readFileSync(log,'utf8').split('start ').length<3){if(Date.now()>deadline)throw Error('Workers were serialized');await delay(5)}}await delay(100)}finally{appendFileSync(log,'end '+i+'\\n')}});`,
  );
  await writeFile(path.join(root, "workers.log"), "");
  const expected = Array.from({ length: 4 }, (_, i) => ({
    file,
    name: "original-worker-" + i,
  }));
  const report = execute(expected, { isolatedCaseWorkers: 2, timeoutMs: 5000 });
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(report.ledger.terminalEventCount, 4);
  let active = 0,
    maximum = 0,
    completed = 0;
  for (const line of (await readFile(path.join(root, "workers.log"), "utf8"))
    .trim()
    .split("\n")) {
    if (line.startsWith("start ")) {
      active++;
      maximum = Math.max(active, maximum);
    } else {
      assert.match(line, /^end [0-3]$/);
      active--;
      completed++;
    }
    assert.ok(active >= 0 && active <= 2, "Worker ceiling exceeded");
  }
  assert.equal(active, 0);
  assert.equal(completed, 4);
  assert.equal(maximum, Math.min(2, availableParallelism()));
});

test("named native acceptance validates worker bounds before executing any callback", async (t) => {
  const { root } = await ledgerFixture(t);
  const file = path.join(root, "bounded-workers.mjs");
  await writeFile(
    file,
    "import{test}from'node:test';import{writeFileSync}from'node:fs';test('original-required',()=>writeFileSync(new URL('executed',import.meta.url),'yes'));",
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const options of [
    { isolatedCaseWorkers: -1 },
    { isolatedCaseWorkers: 3 },
    { isolatedCaseWorkers: 1.5 },
    { isolatedCaseWorkers: 2, additionalFiles: [file] },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "ledger-runner.mjs"),
        new URL("../../scripts/required-test-evidence.mjs", import.meta.url)
          .href,
        JSON.stringify([{ file, name: "original-required" }]),
        JSON.stringify(options),
      ],
      { env, encoding: "utf8", timeout: 5000 },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    await assert.rejects(access(path.join(root, "executed")), {
      code: "ENOENT",
    });
  }
});

test("formatting acceptance CLI isolates exact callbacks without admitting an adjacent name", async (t) => {
  const root = await fixture(t, {
    "dist/src/original.js": "export const original = true;\n",
  });
  const { mkdir, readFile } = await import("node:fs/promises");
  await mkdir(path.join(root, "scripts"));
  for (const name of [
    "verify-required-native-tests.mjs",
    "required-test-evidence.mjs",
    "compiled-engine-evidence.mjs",
  ])
    await writeFile(
      path.join(root, "scripts", name),
      await readFile(new URL("../../scripts/" + name, import.meta.url)),
    );
  const callback = path.join(root, "original.test.mjs");
  await writeFile(
    callback,
    `import {test} from 'node:test';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';let calls=0;for(let i=0;i<3;i++)test('original ['+i+']',()=>{assert.equal(++calls,1);appendFileSync(new URL('pids',import.meta.url),process.pid+'\\n')});test('original [0] suffix',()=>{throw Error('Adjacent callback ran')});`,
  );
  await writeFile(
    path.join(root, "scripts/required-native-tests.json"),
    JSON.stringify({
      "dotnet-format-extensions": Array.from({ length: 3 }, (_, i) => ({
        file: callback,
        name: "original [" + i + "]",
      })),
    }),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/verify-required-native-tests.mjs"),
      "dotnet-format-extensions",
    ],
    { cwd: root, env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.required, 3);
  assert.equal(report.passed, 3);
  assert.equal(report.ledger.terminalEventCount, 3);
  assert.equal(
    new Set(
      (await readFile(path.join(root, "pids"), "utf8")).trim().split("\n"),
    ).size,
    3,
  );
});

test("required native runner grants the installation budget only to exact isolated generator Ruby Swift and mutation installed callbacks", async (t) => {
  const root = await realpath(await fixture(t, {}));
  const helper = path.join(root, "scripts/required-test-evidence.mjs");
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(
    helper,
    await (
      await import("node:fs/promises")
    ).readFile(
      new URL("../../scripts/required-test-evidence.mjs", import.meta.url),
    ),
  );
  const profiles = [
    "dotnet-generator-extensions",
    "ruby-extensions",
    "swift-extensions",
    "mutation-runners",
  ];
  const requirements = profiles.flatMap((profile) => {
    const exact = path.join(root, "dist/test", `gate-${profile}.test.js`);
    const adjacent = path.join(root, "other", `gate-${profile}.test.js`);
    const installed = `${profile} installed acceptance`;
    return [
      { file: exact, name: installed },
      { file: exact, name: `${profile} broken acceptance` },
      { file: exact, name: installed + "-extra" },
      { file: adjacent, name: installed },
    ];
  });
  for (const file of new Set(requirements.map((item) => item.file))) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      "// Synthetic timer-admission fixture; no native acceptance.\n",
    );
  }
  const runner = path.join(root, "timer-admission.mjs");
  // Observe options at the actual node:test boundary without waiting twenty minutes.
  // Synthetic terminal events exercise harness accounting, not native acceptance.
  await writeFile(
    runner,
    `
import{registerHooks}from'node:module';import{pathToFileURL}from'node:url';
const helper=pathToFileURL(process.argv[2]).href,expected=JSON.parse(process.argv[3]),options=JSON.parse(process.argv[4]);
globalThis.originalTimerCalls=[];globalThis.originalTimerExpected=expected;
const stub="export async function* run(options){globalThis.originalTimerCalls.push({files:options.files,timeout:options.timeout,patterns:options.testNamePatterns?.map(String)});for(const item of globalThis.originalTimerExpected){if(options.files.includes(item.file)&&(!options.testNamePatterns||options.testNamePatterns.some(p=>p.test(item.name))))yield{type:'test:pass',data:{file:item.file,name:item.name,details:{type:'test',duration_ms:0}}}}}";
registerHooks({resolve(specifier,context,next){return specifier==='node:test'&&context.parentURL===helper?{url:'data:text/javascript,'+encodeURIComponent(stub),shortCircuit:true}:next(specifier,context)}});
const{runRequiredTests}=await import(helper);const report=await runRequiredTests(expected,options);console.log(JSON.stringify({report,calls:globalThis.originalTimerCalls}));
`,
  );
  const invoke = (
    requirements: { file: string; name: string }[],
    timeoutMs = 600000,
    isolatedCaseWorkers = 1,
  ) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        runner,
        helper,
        JSON.stringify(requirements),
        JSON.stringify({ timeoutMs, isolatedCaseWorkers }),
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      report: TerminalReceipt;
      calls: { files: string[]; timeout: number; patterns?: string[] }[];
    };
  };
  const admitted = invoke(requirements);
  assert.equal(admitted.report.complete, true, JSON.stringify(admitted));
  assert.equal(admitted.report.required, requirements.length);
  assert.equal(admitted.report.passed, requirements.length);
  assert.deepEqual(
    admitted.calls.map((call) => call.timeout),
    profiles.flatMap(() => [1200000, 600000, 600000, 600000]),
  );
  assert.deepEqual(
    admitted.calls.map((call) => call.files),
    requirements.map((item) => [item.file]),
  );
  assert.ok(admitted.calls.every((call) => call.patterns?.length === 1));
  for (const budget of [1000, 599999]) {
    const custom = invoke(
      [requirements[0]!, requirements[4]!, requirements[8]!, requirements[12]!],
      budget,
    );
    assert.deepEqual(
      custom.calls.map((call) => call.timeout),
      [budget, budget, budget, budget],
    );
  }
  const batch = invoke(requirements, 600000, 0);
  assert.equal(batch.calls.length, 1);
  assert.equal(batch.calls[0]!.timeout, 600000);
});

test("named required case progress identifies starts and terminal failures without crediting absent or skipped cases", async (t) => {
  const root = await fixture(t, {
    "controls.mjs": `import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('passed',()=>assert.match(readFileSync(new URL('progress.jsonl',import.meta.url),'utf8'),/"phase":"start","name":"passed"/));test('failed',()=>{throw Error('original synthetic failure')});test('skipped',{skip:'original unavailable'},()=>{});`,
    "runner.mjs": `import {appendFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';const {runRequiredTests}=await import(process.argv[2]);const progress=[];const evidence=await runRequiredTests(['passed','failed','skipped','absent'].map(name=>({file:fileURLToPath(new URL('controls.mjs',import.meta.url)),name})),{timeoutMs:5000,isolatedCaseWorkers:1,onCaseProgress:event=>{progress.push(event);appendFileSync(new URL('progress.jsonl',import.meta.url),JSON.stringify(event)+'\\n');}});console.log(JSON.stringify({evidence,progress}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "runner.mjs"),
      new URL("../../scripts/required-test-evidence.mjs", import.meta.url).href,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { evidence, progress } = JSON.parse(result.stdout) as {
    evidence: TerminalReceipt;
    progress: Array<{
      phase: string;
      name: string;
      outcome?: string;
      message?: string;
    }>;
  };
  assert.equal(evidence.complete, false);
  assert.equal(evidence.required, 4);
  assert.deepEqual(
    evidence.ledger.cases.map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: "passed", outcome: "passed" },
      { name: "failed", outcome: "failed" },
      { name: "skipped", outcome: "skipped" },
      { name: "absent", outcome: "not-observed" },
    ],
  );
  assert.deepEqual(
    progress
      .filter((event) => event.phase === "start")
      .map((event) => event.name),
    ["passed", "failed", "skipped", "absent"],
  );
  assert.deepEqual(
    progress
      .filter((event) => event.phase === "finished")
      .map((event) => event.name),
    ["passed", "failed", "skipped", "absent"],
  );
  assert.deepEqual(
    progress
      .filter((event) => event.phase === "terminal")
      .map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: "passed", outcome: "passed" },
      { name: "failed", outcome: "failed" },
      { name: "skipped", outcome: "skipped" },
    ],
  );
  assert.equal(
    progress.find(
      (event) => event.phase === "terminal" && event.name === "failed",
    )?.message,
    "original synthetic failure",
  );
  assert.ok(
    evidence.problems.some(
      (problem) =>
        problem.name === "absent" &&
        problem.reason === "required-test-not-passed",
    ),
  );
  assert.ok(
    evidence.problems.some(
      (problem) =>
        problem.name === "skipped" && problem.reason === "skipped-or-todo",
    ),
  );
});

test(
  "packaged review failure preserves its complete bounded ledger before reporting a nonzero exit",
  { skip: process.platform === "win32" },
  async (t) => {
    const { chmod } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const ledger = {
      complete: false,
      ledger: {
        padding: "x".repeat(16000),
        terminal: "original-final-ledger-witness",
      },
    };
    const root = await fixture(t, {
      docker: `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='image')console.log('sha256:'+'a'.repeat(64));
else if(args.includes('--version'))console.log(args.includes('git')?'git version 2.47.3':'v22.23.2');
else {console.log(${JSON.stringify(JSON.stringify(ledger))});process.exitCode=7;}
`,
    });
    await chmod(path.join(root, "docker"), 0o755);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: root + path.delimiter + process.env.PATH,
    };
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/verify-review-container.mjs", import.meta.url),
        ),
      ],
      {
        env: environment,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Required review source cohort failed/);
    assert.deepEqual(JSON.parse(result.stdout), ledger);
  },
);
