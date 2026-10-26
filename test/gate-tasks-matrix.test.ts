import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { openTaskStore } from "../src/task-store.js";
import { passingTest } from "./helpers.js";
import {
  setup,
  taskExecutionTimeoutMs,
  wire,
  taskId,
  terminal,
  report,
  slow,
  started,
  stopped,
  acknowledge,
} from "./tasks-wire-fixture.js";

function decisionSource(condition: string, nearMiss = false) {
  return `import {test} from 'node:test'; import assert from 'node:assert/strict';
function permits(name){return ${condition};}
test('exact grant',()=>assert.equal(permits('${nearMiss ? "grant:read" : "grant"}'),true));
test('adjacent identifier refused',()=>assert.equal(permits('${nearMiss ? "Grant:read" : "granting"}'),false));`;
}
async function paired(
  t: TestContext,
  source: string,
  expected: "passed" | "failed",
) {
  const opt = await setup(t, source);
  const fingerprint = (await createPlan(opt.root)).plan.sourceFingerprint;
  const connection = await wire(t, opt, ["--allow-execution", "--detailed"]);
  const id = taskId(
    await connection.request("tools/call", {
      name: "validation_run",
      arguments: {},
    }),
  );
  const result = await terminal(connection, id);
  assert.equal(result.status, "completed");
  const evidence = report(result) as {
    outcome: string;
    sourceFingerprint: string;
    checks: Array<{
      tests?: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
      };
    }>;
  };
  assert.equal(evidence.outcome, expected, JSON.stringify(result));
  assert.equal(evidence.sourceFingerprint, fingerprint);
  assert.deepEqual(
    evidence.checks.map((c) => c.tests),
    [
      {
        total: 2,
        passed: expected === "passed" ? 2 : 1,
        failed: expected === "failed" ? 1 : 0,
        skipped: 0,
      },
    ],
  );
  await connection.close();
  const reopened = await wire(t, opt, ["--detailed"]);
  assert.deepEqual(
    (await reopened.request("tasks/get", { taskId: id })).result,
    result,
  );
  acknowledge(await reopened.request("tasks/cancel", { taskId: id }));
  assert.deepEqual(
    (await reopened.request("tasks/get", { taskId: id })).result,
    result,
  );
}

test("tasks-matrix broken acceptance", async (t) => {
  await paired(t, decisionSource("name.startsWith('grant')"), "failed");
});
test("tasks-matrix fixed acceptance", async (t) => {
  await paired(
    t,
    decisionSource("name==='grant'||name.startsWith('grant:')"),
    "passed",
  );
});
test("tasks-matrix near-miss acceptance", async (t) => {
  await paired(
    t,
    decisionSource("name==='grant'||name.startsWith('grant:')", true),
    "passed",
  );
  const opt = await setup(t);
  const connection = await wire(t, opt, [], false);
  assert.equal(
    (await connection.request("server/discover")).result?.capabilities !==
      undefined,
    true,
  );
  assert.equal(
    (
      await connection.request("tasks/get", {
        taskId: "00000000-0000-4000-8000-000000000000",
      })
    ).error?.code,
    -32601,
  );
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
});
test("tasks-matrix prerequisite acceptance", async (t) => {
  const opt = await setup(t);
  const missing = path.join(
    path.dirname(opt.directory),
    "missing-parent",
    "store",
  );
  await assert.rejects(openTaskStore({ ...opt, directory: missing }), {
    code: "ENOENT",
  });
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const unknown = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/verify-tasks-runtime.mjs", import.meta.url),
      ),
      "original-unknown-slot",
    ],
    { env, encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
  );
  assert.equal(unknown.error, undefined);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown frozen runtime slot/);
  const denied = await wire(t, opt, []);
  assert.equal(
    (
      await denied.request("tools/call", {
        name: "validation_run",
        arguments: { trusted: true },
      })
    ).result?.isError,
    true,
  );
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
});
test("tasks-matrix stale acceptance", async (t) => {
  const opt = await setup(t);
  const original = (await createPlan(opt.root)).plan.sourceFingerprint;
  const store = await openTaskStore(opt);
  try {
    const task = store.create(original);
    await writeFile(
      path.join(opt.root, "check.test.js"),
      passingTest.replace("2 + 3, 5", "2 + 3, 6"),
    );
    const changed = await validate(opt.root, {
      trusted: true,
      timeoutMs: taskExecutionTimeoutMs,
    });
    assert.equal(changed.outcome, "failed");
    assert.notEqual(changed.sourceFingerprint, original);
    assert.throws(
      () => store.complete(task.taskId, changed),
      /source fingerprints differ/,
    );
    assert.equal(store.get(task.taskId).status, "working");
    assert.equal(store.get(task.taskId).result, undefined);
  } finally {
    store.close();
  }
});
test("tasks-matrix empty acceptance", async (t) => {
  for (const source of [
    "",
    "import {test} from 'node:test';test('original skipped',{skip:true},()=>{});",
  ]) {
    const opt = await setup(t, source);
    const connection = await wire(t, opt);
    const result = await terminal(
      connection,
      taskId(
        await connection.request("tools/call", {
          name: "validation_run",
          arguments: {},
        }),
      ),
    );
    assert.equal(result.status, "completed");
    const evidence = report(result) as {
      outcome: string;
      checks: Array<{
        status: string;
        tests?: { total: number; passed: number; skipped: number };
      }>;
    };
    assert.equal(evidence.outcome, "incomplete");
    assert.equal(evidence.checks.length, 1);
    assert.notEqual(evidence.checks[0]!.status, "passed");
    if (source === "") assert.equal(evidence.checks[0]!.tests, undefined);
    else
      assert.deepEqual(evidence.checks[0]!.tests, {
        total: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
      });
    await connection.close();
  }
});
test("tasks-matrix privacy acceptance", async (t) => {
  const opt = await setup(t);
  const denied = await wire(t, opt, []);
  for (const args of [{}, { trusted: true }, { directory: opt.directory }]) {
    const result = await denied.request("tools/call", {
      name: "validation_run",
      arguments: args,
    });
    assert.equal(result.result?.isError, true);
    assert.equal(JSON.stringify(result).includes(opt.root), false);
  }
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  await denied.close();
  const allowed = await wire(t, opt);
  const result = await terminal(
    allowed,
    taskId(
      await allowed.request("tools/call", {
        name: "validation_run",
        arguments: {},
      }),
    ),
  );
  assert.equal(report(result).outcome, "passed");
  for (const secret of [
    opt.root,
    opt.directory,
    "check.test.js",
    "adds integers",
    passingTest,
  ])
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  await allowed.close();
  await assert.rejects(openTaskStore({ ...opt, detailed: true }), /disclosure/);
});
test("tasks-matrix lifecycle acceptance", { timeout: 60000 }, async (t) => {
  for (const mode of ["cancel", "timeout", "output"]) {
    const flood = slow.replace(
      "await new Promise(resolve=>setTimeout(resolve,60000));",
      "while(!fs.existsSync('.checktrail/release-output')) await new Promise(resolve=>setTimeout(resolve,10));process.stdout.write('x'.repeat(6*1024*1024));await new Promise(resolve=>setTimeout(resolve,60000));",
    );
    assert.notEqual(flood, slow);
    const opt = await setup(t, mode === "output" ? flood : slow);
    const connection = await wire(t, opt, [
      "--allow-execution",
      "--timeout-ms",
      "5000",
    ]);
    const id = taskId(
      await connection.request("tools/call", {
        name: "validation_run",
        arguments: {},
      }),
    );
    const pids = await started(t, opt.root);
    if (mode === "cancel")
      acknowledge(await connection.request("tasks/cancel", { taskId: id }));
    else if (mode === "output")
      await writeFile(path.join(opt.root, ".checktrail/release-output"), "");
    const terminalTask = await terminal(connection, id, 10000);
    await stopped(pids);
    assert.equal(
      terminalTask.status,
      mode === "cancel" ? "cancelled" : "completed",
    );
    if (mode !== "cancel")
      assert.equal(report(terminalTask).outcome, "incomplete");
    else assert.equal(terminalTask.result, undefined);
    await connection.close();
    const reopened = await wire(t, opt, []);
    assert.deepEqual(
      (await reopened.request("tasks/get", { taskId: id })).result,
      terminalTask,
    );
  }
});
// A fresh installation repeats the complete runtime cohort. Windows native
// controls need their own aggregate allowance; project execution stays bounded
// by the unchanged engine limits and the outer native-file deadline.
const installedTimeout = process.platform === "win32" ? 600000 : 180000;
test(
  "tasks-matrix installed acceptance",
  { timeout: installedTimeout },
  async () => {
    if (process.env.CHECKTRAIL_TASKS_MATRIX_INSTALLED === "1") {
      const runtime = await realpath(
        fileURLToPath(new URL("../src/task-store.js", import.meta.url)),
      );
      assert.ok(
        runtime.includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-tasks-runtime-package.mjs",
            import.meta.url,
          ),
        ),
        ...(process.env.CHECKTRAIL_TASKS_RUNTIME_SLOT
          ? [process.env.CHECKTRAIL_TASKS_RUNTIME_SLOT]
          : []),
      ],
      {
        env,
        encoding: "utf8",
        timeout: process.platform === "win32" ? 590000 : 170000,
        maxBuffer: 4 * 1048576,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      (result.stdout + result.stderr).slice(-1600),
    );
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    assert.equal(receipt.evidence.profileEvidence.complete, true);
    assert.equal(
      receipt.evidence.profileEvidence.required,
      process.platform === "win32" ? 29 : 26,
    );
    for (const control of [
      "Tasks fixture teardown closes every live SQLite server before removing its directories",
      "Tasks wire fixtures select bounded Windows budgets and preserve explicit lifecycle execution limits",
      "Tasks runtime selection binds every frozen acceptance case and preserves the complete platform control family",
    ]) {
      assert.deepEqual(
        receipt.evidence.profileEvidence.ledger.cases
          .filter((entry: { name: string }) => entry.name === control)
          .map((entry: { outcome: string }) => entry.outcome),
        ["passed"],
        "The fresh installed cohort must execute each required fixture control exactly once",
      );
    }
    assert.equal(
      receipt.evidence.profileEvidence.passed,
      receipt.evidence.profileEvidence.required,
    );
    const { writeRuntimeInstallation } = await import(
      new URL("../../scripts/runtime-installation-capture.mjs", import.meta.url)
        .href
    );
    await writeRuntimeInstallation("tasks", receipt);
  },
);
