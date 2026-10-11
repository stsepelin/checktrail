import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openTaskStore } from "../src/task-store.js";
import { createPlan } from "../src/engine.js";
import { McpValidationTasks } from "../src/mcp-validation-tasks.js";
import { passingTest } from "./helpers.js";
import {
  extension,
  setup,
  wire,
  acknowledge,
  taskId,
  terminal,
  report,
  slow,
  alive,
  started,
  stopped,
} from "./tasks-wire-fixture.js";

test("MCP Tasks capability is operator enabled and per-request; discovery and planning create no store", async (t) => {
  const opt = await setup(t);
  const connection = await wire(t, opt);
  const discovery = await connection.request("server/discover");
  assert.deepEqual(
    (discovery.result?.capabilities as { extensions: unknown }).extensions,
    { [extension]: {} },
  );
  const plan = await connection.request("tools/call", {
    name: "validation_plan",
    arguments: {},
  });
  assert.equal(plan.result?.isError, undefined);
  const injectedPlan = await connection.request("tools/call", {
    name: "validation_plan",
    arguments: { unrecognized: true },
  });
  assert.equal(injectedPlan.result?.isError, true);
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  const unknown = "00000000-0000-4000-8000-000000000000";
  const unsupported = await connection.request(
    "tasks/get",
    { taskId: unknown },
    false,
  );
  assert.equal(unsupported.error?.code, -32021);
  assert.deepEqual(unsupported.error?.data, {
    requiredCapabilities: { extensions: { [extension]: {} } },
  });
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  const plain = await connection.request(
    "tools/call",
    { name: "validation_run", arguments: {} },
    false,
  );
  assert.equal(plain.result?.resultType, "complete");
  assert.equal(
    (plain.result.structuredContent as { outcome: string }).outcome,
    "passed",
  );
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  const absentOpt = await setup(t);
  const disabled = await wire(t, absentOpt, [], false);
  const disabledDiscovery = await disabled.request("server/discover");
  assert.equal(
    (disabledDiscovery.result?.capabilities as { extensions?: unknown })
      .extensions,
    undefined,
  );
  assert.equal(
    (await disabled.request("tasks/get", { taskId: unknown })).error?.code,
    -32601,
  );
});

test("MCP Tasks durably create, retrieve and reopen passed failed and empty native outcomes", async (t) => {
  const opt = await setup(t);
  const connection = await wire(t, opt);
  const results: { id: string; task: Record<string, unknown> }[] = [];
  for (const [source, outcome] of [
    [passingTest, "passed"],
    [passingTest.replace("2 + 3, 5", "2 + 3, 6"), "failed"],
    ["", "incomplete"],
  ] as const) {
    await writeFile(path.join(opt.root, "check.test.js"), source);
    const id = taskId(
      await connection.request("tools/call", {
        name: "validation_run",
        arguments: {},
      }),
    );
    const immediate = await connection.request("tasks/get", { taskId: id });
    assert.equal(immediate.error, undefined);
    const task = await terminal(connection, id);
    assert.equal(task.status, "completed");
    assert.equal(report(task).outcome, outcome);
    assert.ok(!JSON.stringify(task).includes(opt.root));
    assert.ok(!JSON.stringify(task).includes("check.test.js"));
    results.push({ id, task });
  }
  await connection.close();
  const reopened = await wire(t, opt, []);
  for (const value of results) {
    assert.deepEqual(
      (await reopened.request("tasks/get", { taskId: value.id })).result,
      value.task,
    );
    acknowledge(await reopened.request("tasks/cancel", { taskId: value.id }));
    acknowledge(
      await reopened.request("tasks/update", {
        taskId: value.id,
        inputResponses: { unknown: { decision: "accept" } },
      }),
    );
  }
  const denied = await reopened.request("tools/call", {
    name: "validation_run",
    arguments: {},
  });
  assert.equal(denied.result?.isError, true);
  assert.equal(denied.result.resultType, "complete");
});

test("MCP Tasks reject tool trust injection timeout changes and unknown handles without leaking paths", async (t) => {
  const opt = await setup(t);
  const connection = await wire(t, opt, []);
  for (const args of [
    {},
    { trusted: true },
    { directory: opt.directory },
    { timeoutMs: 4999 },
  ]) {
    const result = await connection.request("tools/call", {
      name: "validation_run",
      arguments: args,
    });
    assert.equal(result.result?.isError, true);
    assert.equal(result.result.resultType, "complete");
    assert.ok(!JSON.stringify(result).includes(opt.root));
  }
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
    const result = await connection.request(method, {
      taskId: "00000000-0000-4000-8000-000000000000",
      inputResponses: {},
    });
    assert.equal(result.error?.code, -32602);
    assert.equal(result.error.message, "Task unavailable or expired");
    assert.ok(!JSON.stringify(result).includes(opt.directory));
  }
  const trustedOpt = await setup(t);
  const trusted = await wire(t, trustedOpt);
  assert.equal(
    (
      await trusted.request("tools/call", {
        name: "validation_run",
        arguments: { timeoutMs: 4999 },
      })
    ).result?.isError,
    true,
  );
  await assert.rejects(stat(trustedOpt.directory), { code: "ENOENT" });
  const result = await terminal(
    trusted,
    taskId(
      await trusted.request("tools/call", {
        name: "validation_run",
        arguments: { timeoutMs: 5000 },
      }),
    ),
  );
  assert.equal(report(result).outcome, "passed");
});

test("MCP Tasks ordinary request cancellation leaves background work alive and explicit cancellation waits for descendants", async (t) => {
  const opt = await setup(t, slow);
  const connection = await wire(t, opt);
  const id = taskId(
    await connection.request("tools/call", {
      name: "validation_run",
      arguments: {},
    }),
  );
  const pids = await started(t, opt.root);
  connection.notify("notifications/cancelled", { requestId: 0 });
  await delay(100);
  assert.equal(
    (await connection.request("tasks/get", { taskId: id })).result?.status,
    "working",
  );
  assert.equal(await alive(pids.pid), true);
  assert.equal(await alive(pids.child), true);
  for (const name of [
    "validation_run",
    "mutation_experiment",
    "review_workflow",
  ]) {
    const args =
      name === "mutation_experiment"
        ? { input: "not-read.json" }
        : name === "review_workflow"
          ? {
              operation: "probe",
              workflowId: "00000000-0000-4000-8000-000000000000",
              probeId: "absent",
            }
          : {};
    const result = await connection.request(
      "tools/call",
      { name, arguments: args },
      false,
    );
    assert.equal(result.result?.isError, true);
    assert.match(
      JSON.stringify(result.result?.content),
      name === "review_workflow" ? /capacity/ : /already running/,
    );
  }
  assert.equal(
    (
      await connection.request("tools/call", {
        name: "validation_run",
        arguments: {},
      })
    ).result?.isError,
    true,
  );
  const cancel = await connection.request("tasks/cancel", { taskId: id });
  acknowledge(cancel);
  assert.equal(await alive(pids.pid), false);
  assert.equal(await alive(pids.child), false);
  await stopped(pids);
  const task = await terminal(connection, id);
  assert.equal(task.status, "cancelled");
  assert.equal(task.result, undefined);
  await writeFile(path.join(opt.root, "check.test.js"), passingTest);
  assert.equal(
    report(
      await terminal(
        connection,
        taskId(
          await connection.request("tools/call", {
            name: "validation_run",
            arguments: {},
          }),
        ),
      ),
    ).outcome,
    "passed",
  );
});

test("MCP Tasks foreground shutdown waits for native cleanup and retains cancellation on restart", async (t) => {
  const opt = await setup(t, slow);
  const connection = await wire(t, opt);
  const id = taskId(
    await connection.request("tools/call", {
      name: "validation_run",
      arguments: {},
    }),
  );
  const pids = await started(t, opt.root);
  await connection.close();
  await stopped(pids);
  const reopened = await wire(t, opt, []);
  const task = await terminal(reopened, id);
  assert.equal(task.status, "cancelled");
  assert.equal(task.result, undefined);
});

test("MCP Tasks preserve oversized detail as a completed tool error while summary retains the same native result", async (t) => {
  for (const detailed of [false, true]) {
    const opt = await setup(
      t,
      passingTest + "\nconsole.log('x'.repeat(300000));",
    );
    const connection = await wire(t, opt, [
      "--allow-execution",
      ...(detailed ? ["--detailed"] : []),
    ]);
    const task = await terminal(
      connection,
      taskId(
        await connection.request("tools/call", {
          name: "validation_run",
          arguments: {},
        }),
      ),
    );
    assert.equal(task.status, "completed");
    const result = task.result as {
      isError?: boolean;
      structuredContent?: unknown;
      resultType: string;
    };
    assert.equal(result.resultType, "complete");
    if (detailed) {
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
    } else {
      assert.equal(result.isError, undefined);
      assert.equal(report(task).outcome, "passed");
      assert.ok(!JSON.stringify(task).includes(opt.root));
      assert.ok(!JSON.stringify(task).includes("check.test.js"));
    }
    await connection.close();
  }
});

test("MCP Tasks owner rejects overlap during planning and closes an initialized worker before returning", async (t) => {
  const opt = await setup(t);
  const owner = new McpValidationTasks({
    ...opt,
    allowExecution: true,
    timeoutMs: 5000,
  });
  t.after(() => owner.close());
  const first = assert.rejects(
    owner.start(new AbortController().signal),
    /cancelled/,
  );
  await assert.rejects(
    owner.start(new AbortController().signal),
    /unavailable/,
  );
  await owner.close();
  await first;
  await owner.close();
  const next = new McpValidationTasks({
    ...opt,
    allowExecution: true,
    timeoutMs: 5000,
  });
  try {
    const task = await next.start(new AbortController().signal);
    assert.equal(task.status, "working");
  } finally {
    await next.close();
  }
});

test("MCP Tasks reject expired handles and preserve crash interruption without resuming execution", async (t) => {
  const opt = await setup(
    t,
    "throw new Error('retrieval must not execute project code')",
  );
  const store = await openTaskStore(opt);
  let expired, interrupted;
  try {
    const { plan } = await createPlan(opt.root);
    expired = store.create(plan.sourceFingerprint, 1);
    interrupted = store.create(plan.sourceFingerprint);
  } finally {
    store.close();
  }
  await delay(5);
  const connection = await wire(t, opt, []);
  for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
    const result = await connection.request(method, {
      taskId: expired.taskId,
      inputResponses: {},
    });
    assert.equal(result.error?.code, -32602);
    assert.equal(result.error.message, "Task unavailable or expired");
  }
  const task = await terminal(connection, interrupted.taskId);
  assert.equal(task.status, "completed");
  assert.equal((task.result as { isError: boolean }).isError, true);
  assert.equal(
    (task.result as { structuredContent?: unknown }).structuredContent,
    undefined,
  );
  assert.ok(JSON.stringify(task).includes("Execution was not resumed"));
});

test("MCP Tasks admission shares the ordinary native execution slot in both directions", async (t) => {
  const opt = await setup(t, slow);
  const connection = await wire(t, opt);
  const ordinary = connection.request(
    "tools/call",
    { name: "validation_run", arguments: {} },
    false,
  );
  const pids = await started(t, opt.root);
  const overlap = await connection.request("tools/call", {
    name: "validation_run",
    arguments: {},
  });
  assert.equal(overlap.result?.resultType, "complete");
  assert.equal(overlap.result.isError, true);
  await assert.rejects(stat(opt.directory), { code: "ENOENT" });
  connection.notify("notifications/cancelled", { requestId: 0 });
  const cancelled = await ordinary;
  assert.equal(cancelled.result?.resultType, "complete");
  assert.equal(
    (cancelled.result.structuredContent as { outcome: string }).outcome,
    "incomplete",
  );
  await stopped(pids);
  await writeFile(path.join(opt.root, "check.test.js"), passingTest);
  assert.equal(
    report(
      await terminal(
        connection,
        taskId(
          await connection.request("tools/call", {
            name: "validation_run",
            arguments: {},
          }),
        ),
      ),
    ).outcome,
    "passed",
  );
});

test("MCP Tasks require capabilities for every control request and acknowledge only declared updates", async (t) => {
  const opt = await setup(t);
  const connection = await wire(t, opt);
  const id = taskId(
    await connection.request("tools/call", {
      name: "validation_run",
      arguments: {},
    }),
  );
  const task = await terminal(connection, id);
  for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
    const denied = await connection.request(
      method,
      { taskId: id, inputResponses: {} },
      false,
    );
    assert.equal(denied.error?.code, -32021);
    assert.deepEqual(denied.error?.data, {
      requiredCapabilities: { extensions: { [extension]: {} } },
    });
  }
  const missing = await connection.request("tasks/update", { taskId: id });
  assert.equal(missing.error?.code, -32602);
  assert.equal(missing.error.message, "Task update requires inputResponses");
  acknowledge(
    await connection.request("tasks/update", {
      taskId: id,
      inputResponses: { unissued: { decision: "accept" } },
    }),
  );
  acknowledge(
    await connection.request("tasks/update", {
      taskId: id,
      inputResponses: {},
    }),
  );
  assert.deepEqual(
    (await connection.request("tasks/get", { taskId: id })).result,
    task,
  );
});
