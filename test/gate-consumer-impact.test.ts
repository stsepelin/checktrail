import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { inventory } from "../src/inventory.js";
import { reconcileConsumerImports } from "../src/consumer-imports.js";
import { projectPlan, projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import {
  fixture,
  captureFixtureProcessGroup,
  cleanupFixtureProcessGroup,
} from "./helpers.js";
import { alive, stopped } from "./tasks-wire-fixture.js";
import {
  consumerFixture,
  consumerProjects,
  consumerDependencies,
  changeConsumerPolicy,
  assertConsumerExecution,
  assertNoConsumerMarker,
} from "./consumer-impact-fixture.js";
import {
  beginConsumerWitness,
  finishConsumerProjectWitness,
} from "./consumer-witness-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const executionTimeout = process.platform === "win32" ? 30000 : 10000;

test("consumer-impact broken acceptance", async (t) => {
  for (const dependencies of [
    consumerDependencies,
    consumerDependencies.slice(0, 1),
  ]) {
    const { root, base } = await consumerFixture(t, dependencies);
    await changeConsumerPolicy(root, "prefix");
    const fullCapture = await beginConsumerWitness(
      root,
      "javascript",
      "broken",
      dependencies.length === 2 ? "canonical" : "repeat",
    );
    const full = await validate(root, {
      trusted: true,
      timeoutMs: executionTimeout,
    });
    await finishConsumerProjectWitness(
      fullCapture,
      full,
      dependencies.length === 2 ? "workspace" : "unknown-map",
    );
    const selectedCapture = await beginConsumerWitness(
      root,
      "shared-json",
      "broken",
      dependencies.length === 2 ? "canonical" : "repeat",
    );
    const selected = await validate(root, {
      trusted: true,
      base,
      timeoutMs: executionTimeout,
    });
    await finishConsumerProjectWitness(
      selectedCapture,
      selected,
      dependencies.length === 2 ? "workspace" : "unknown-map",
    );
    assertConsumerExecution(full, "failed", consumerProjects);
    assertConsumerExecution(
      selected,
      "failed",
      dependencies.length === 2 ? ["app", "lib", "site"] : consumerProjects,
    );
    assert.equal(
      selected.selection?.mode,
      dependencies.length === 2 ? "affected" : "full",
    );
    if (dependencies.length === 1)
      assert.match(
        selected.selection!.reason,
        /omit a captured source consumer/,
      );
    assert.equal(full.sourceFingerprint, selected.sourceFingerprint);
    assert.deepEqual(
      selected.checks
        .filter((c) => c.status === "failed")
        .map((c) => c.project),
      full.checks.filter((c) => c.status === "failed").map((c) => c.project),
    );
    assert.deepEqual(
      full.checks.filter((c) => c.status === "failed").map((c) => c.project),
      ["app", "site"],
    );
  }
});
test("consumer-impact fixed acceptance", async (t) => {
  const { root, base } = await consumerFixture(t);
  await changeConsumerPolicy(root, "fixed", "equivalent repair");
  const fullCapture = await beginConsumerWitness(root, "javascript", "fixed");
  const full = await validate(root, {
    trusted: true,
    timeoutMs: executionTimeout,
  });
  await finishConsumerProjectWitness(fullCapture, full, "workspace");
  const selectedCapture = await beginConsumerWitness(
    root,
    "shared-json",
    "fixed",
  );
  const selected = await validate(root, {
    trusted: true,
    base,
    timeoutMs: executionTimeout,
  });
  await finishConsumerProjectWitness(selectedCapture, selected, "workspace");
  assertConsumerExecution(full, "passed", consumerProjects);
  assertConsumerExecution(selected, "passed", ["app", "lib", "site"]);
  assert.ok(selected.checks.length < full.checks.length);
  assert.equal(selected.selection?.mode, "affected");
  assert.equal(selected.sourceFingerprint, full.sourceFingerprint);
  const evidence = await reconcileConsumerImports(
    await inventory(root),
    consumerProjects,
    { complete: true, dependencies: consumerDependencies },
  );
  assert.equal(evidence.status, "resolved");
  assert.deepEqual(evidence.edges, consumerDependencies);
});
test("consumer-impact near-miss acceptance", async (t) => {
  const { root, base } = await consumerFixture(t);
  await changeConsumerPolicy(
    root,
    "fixed",
    "grantToken is outside the grant family",
  );
  const fullCapture = await beginConsumerWitness(
    root,
    "javascript",
    "near-miss",
  );
  const full = await validate(root, {
    trusted: true,
    timeoutMs: executionTimeout,
  });
  await finishConsumerProjectWitness(fullCapture, full, "workspace");
  const selectedCapture = await beginConsumerWitness(
    root,
    "shared-json",
    "near-miss",
  );
  const selected = await validate(root, {
    trusted: true,
    base,
    timeoutMs: executionTimeout,
  });
  await finishConsumerProjectWitness(selectedCapture, selected, "workspace");
  assertConsumerExecution(full, "passed", consumerProjects);
  assertConsumerExecution(selected, "passed", ["app", "lib", "site"]);
  for (const suffix of [
    "ts",
    "py",
    "go",
    "php",
    "rs",
    "java",
    "kt",
    "scala",
    "cs",
    "fs",
    "vb",
    "rb",
    "swift",
    "c",
    "cpp",
    "tf",
    "yaml",
  ]) {
    const file = path.join(root, "app/unsupported." + suffix);
    await writeFile(file, "// original inert unsupported input\n");
    try {
      const unknown = await reconcileConsumerImports(
        await inventory(root),
        consumerProjects,
        { complete: true, dependencies: consumerDependencies },
      );
      assert.equal(unknown.status, "unknown", suffix);
      assert.deepEqual(
        (await createPlan(root, { base })).plan.checks.map((c) => c.project),
        consumerProjects,
        suffix,
      );
    } finally {
      const { unlink } = await import("node:fs/promises");
      await unlink(file);
    }
  }
});
test("consumer-impact prerequisite acceptance", async (t) => {
  const { root, base } = await consumerFixture(t);
  await changeConsumerPolicy(root, "prefix");
  const missing = await runProcess(
    root,
    {
      executable: "checktrail-original-absent-runtime-739ab",
      args: [],
      cwd: ".",
    },
    { timeoutMs: 1000 },
  );
  assert.equal(missing.errorCode, "ENOENT");
  assert.notEqual(missing.exitCode, 0);
  for (const absent of ["original-unavailable-history", "--invalid-option"]) {
    const planned = await createPlan(root, { base: absent });
    assert.equal(planned.plan.selection?.mode, "full");
    assert.deepEqual(
      planned.plan.checks.map((c) => c.project),
      consumerProjects,
    );
  }
  const invalid = await fixture(t, { "package.json": "{broken" });
  await assert.rejects(createPlan(invalid));
  await assert.rejects(
    validate(root, { trusted: false, base }),
    /operator trust/,
  );
  assertConsumerExecution(
    await validate(root, { trusted: true, base, timeoutMs: executionTimeout }),
    "failed",
    ["app", "lib", "site"],
  );
});
async function waitMarker(root: string, name: string) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(
        await readFile(path.join(root, "app/.checktrail", name), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw Error("Original consumer native readiness was not reached");
}
test("consumer-impact stale acceptance", async (t) => {
  const { root, base } = await consumerFixture(t);
  await changeConsumerPolicy(root, "fixed");
  const old = await inventory(root);
  await writeFile(
    path.join(root, "app/value.test.js"),
    "import{test}from'node:test';import{writeFileSync,renameSync,existsSync}from'node:fs';test('original source-change witness',async()=>{writeFileSync('.checktrail/ready.json.pending','{}');renameSync('.checktrail/ready.json.pending','.checktrail/ready.json');while(!existsSync('.checktrail/release'))await new Promise(r=>setTimeout(r,10));});",
  );
  const running = validate(root, {
    trusted: true,
    base,
    timeoutMs: executionTimeout,
  });
  try {
    await waitMarker(root, "ready.json");
    await changeConsumerPolicy(
      root,
      "fixed",
      "changed while native consumer runs",
    );
  } finally {
    await writeFile(path.join(root, "app/.checktrail/release"), "");
  }
  const report = await running;
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.sourceChanged, true);
  assert.notEqual(report.sourceFingerprint, report.finalSourceFingerprint);
  assert.ok(report.checks.every((c) => c.status === "passed"));
  assert.equal(
    (
      await reconcileConsumerImports(old, consumerProjects, {
        complete: true,
        dependencies: consumerDependencies,
      })
    ).status,
    "unknown",
  );
});
test("consumer-impact empty acceptance", async (t) => {
  const empty = await fixture(t, {});
  const noChecks = await validate(empty, { trusted: true });
  assert.equal(noChecks.outcome, "incomplete");
  assert.deepEqual(noChecks.checks, []);
  for (const source of [
    "",
    "import{test}from'node:test';test('original skipped consumer',{skip:true},()=>{});",
  ]) {
    const { root, base } = await consumerFixture(t);
    await changeConsumerPolicy(root, "fixed");
    await writeFile(path.join(root, "app/value.test.js"), source);
    const report = await validate(root, {
      trusted: true,
      base,
      timeoutMs: executionTimeout,
    });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks.length, 3);
    assert.notEqual(
      report.checks.find((c) => c.project === "app")!.status,
      "passed",
    );
    assert.deepEqual(
      report.checks.filter((c) => c.project !== "app").map((c) => c.status),
      ["passed", "passed"],
    );
  }
});
test("consumer-impact privacy acceptance", async (t) => {
  const { root, base } = await consumerFixture(t);
  await changeConsumerPolicy(root, "fixed");
  const planned = (await createPlan(root, { base })).plan,
    summary = projectPlan(planned, false);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [cli, "plan", "--root", root, "--base", base],
    { env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), summary);
  const client = new Client(
    { name: "original-consumer-host", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--base", base],
        stderr: "pipe",
      }),
    );
    const plan = await client.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.equal(plan.isError, undefined);
    assert.deepEqual(plan.structuredContent, summary);
    for (const args of [{}, { trusted: true }])
      assert.equal(
        (await client.callTool({ name: "validation_run", arguments: args }))
          .isError,
        true,
      );
  } finally {
    await client.close();
  }
  const report = await validate(root, {
    trusted: true,
    base,
    timeoutMs: executionTimeout,
  });
  assertConsumerExecution(report, "passed", ["app", "lib", "site"]);
  for (const text of [
    JSON.stringify(summary),
    JSON.stringify(projectReport(report, false)),
  ])
    for (const secret of [
      root,
      "policy.json",
      "exact boundary",
      "value.test.js",
    ])
      assert.equal(text.includes(secret), false, secret);
  await writeFile(
    path.join(root, "app/value.test.js"),
    "import{writeFileSync}from'node:fs';writeFileSync('.checktrail/executed','executed');",
  );
  await createPlan(root, { base });
  await assertNoConsumerMarker(root);
  const denied = new Client(
    { name: "original-consumer-denied", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await denied.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root, "--base", base],
        stderr: "pipe",
      }),
    );
    for (const args of [{}, { trusted: true }])
      assert.equal(
        (await denied.callTool({ name: "validation_run", arguments: args }))
          .isError,
        true,
      );
  } finally {
    await denied.close();
  }
  await assertNoConsumerMarker(root);
});
test("consumer-impact lifecycle acceptance", { timeout: 120000 }, async (t) => {
  for (const mode of ["cancel", "timeout", "output"]) {
    const { root, base } = await consumerFixture(t);
    await changeConsumerPolicy(root, "fixed");
    await writeFile(
      path.join(root, "app/value.test.js"),
      `import{test}from'node:test';import fs from'node:fs';import{spawn}from'node:child_process';test('original owned consumer tree',async()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync('.checktrail/started.json.pending',JSON.stringify({pid:process.pid,parent:process.ppid,child:child.pid}));fs.renameSync('.checktrail/started.json.pending','.checktrail/started.json');${mode === "output" ? "while(!fs.existsSync('.checktrail/release'))await new Promise(r=>setTimeout(r,10));process.stdout.write('x'.repeat(6*1024*1024));" : ""}await new Promise(r=>setTimeout(r,60000));});`,
    );
    const controller = new AbortController();
    const running = validate(root, {
      trusted: true,
      base,
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 5000 : 20000,
    });
    let pids: { pid: number; parent: number; child: number } | undefined;
    try {
      pids = await waitMarker(root, "started.json");
      assert.ok(Number.isSafeInteger(pids!.parent) && pids!.parent > 1);
      assert.equal(new Set([pids!.pid, pids!.parent, pids!.child]).size, 3);
      if (process.platform !== "win32") {
        const group = await captureFixtureProcessGroup(pids!.pid, pids!.parent);
        t.after(() => cleanupFixtureProcessGroup(group));
      }
      assert.equal(await alive(pids!.pid), true);
      assert.equal(await alive(pids!.child), true);
      if (mode === "cancel") controller.abort();
      if (mode === "output")
        await writeFile(path.join(root, "app/.checktrail/release"), "");
      const report = await running;
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks.length, 4);
      const result = report.checks.find((c) => c.project === "app")!
        .processes[0]!;
      assert.equal(result.cancelled, mode === "cancel");
      assert.equal(result.timedOut, mode === "timeout");
      assert.equal(result.truncated, mode === "output");
      assert.equal(
        report.checks.some((c) => c.status === "failed"),
        false,
      );
      await stopped(pids!);
    } finally {
      controller.abort();
      await running;
      if (pids) await stopped(pids);
    }
  }
});
const installedObservationMs = process.platform === "win32" ? 600000 : 240000;

test(
  "consumer-impact installed acceptance",
  { timeout: installedObservationMs },
  async () => {
    if (process.env.CHECKTRAIL_CONSUMER_WHOLE_INSTALLED === "1") {
      const runtime = await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
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
            "../../scripts/verify-consumer-impact-whole-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      {
        env,
        encoding: "utf8",
        timeout: installedObservationMs - 10000,
        maxBuffer: 8 * 1048576,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      (result.stdout + result.stderr).slice(-5000),
    );
    const receipt = JSON.parse(result.stdout);
    if (process.env.CHECKTRAIL_CONSUMER_RUNTIME_ACTIVE === "1") {
      const file = process.env.CHECKTRAIL_CONSUMER_RUNTIME_RECEIPT;
      assert.equal(typeof file, "string");
      assert.ok(path.isAbsolute(file!));
      await writeFile(file!, JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      });
    }
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.harnessOutsideInstalledPackage, true);
    assert.equal(receipt.profileEvidence.complete, true);
    assert.equal(receipt.profileEvidence.required, 9);
    assert.equal(receipt.profileEvidence.passed, 9);
    assert.equal(receipt.profileEvidence.ledger.truncated, false);
  },
);
