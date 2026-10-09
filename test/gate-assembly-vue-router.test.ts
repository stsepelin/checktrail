import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { vueRouterEvidence } from "../src/vue-router-evidence.js";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  source,
  profile,
  expectedHooks,
  project,
  run,
} from "./review-vue-router-assembly-fixture.js";
const skip = await access(
  fileURLToPath(
    new URL(
      "../../.checktrail/vue-router-tools/node_modules/vue-router/package.json",
      import.meta.url,
    ),
  ),
).then(
  () => false,
  () => "Prepared pinned Vue Router assembly runtime unavailable",
);
test("assembly-vue-router broken acceptance", { skip }, async (t) => {
  const broken = source.replace(
    "router.beforeEach(initialize); router.beforeEach(authorize);",
    "router.beforeEach(authorize); router.beforeEach(initialize);",
  );
  assert.notEqual(broken, source);
  const report = await run(t, broken);
  assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
  assert.deepEqual(
    report.checks[0]!.findings!.map((f) => f.ruleId),
    [
      "vue-router/assembly-hooks-mismatch",
      "vue-router/assembly-navigation-mismatch",
    ],
  );
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.equal(raw.navigation[1].fullPath, "/deny");
  assert.equal(raw.navigation[1].matched.at(-1).name, "deny");
});
test("assembly-vue-router fixed acceptance", { skip }, async (t) => {
  const report = await run(t);
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  const check = report.checks[0]!;
  assert.equal(check.findingsComplete, true);
  assert.deepEqual(check.findings, []);
  assert.equal(check.runtime!.collections.length, 2);
  assert.equal(check.runtime!.collections[0]!.entries.length, 8);
  assert.equal(check.runtime!.collections[1]!.entries.length, 5);
  assert.ok(check.runtime!.collections.every((c) => c.complete));
  assert.deepEqual(
    check.runtime!.collections[1]!.entries.map((e) => e.attributes),
    expectedHooks.map((h) => ({ ...h, reached: true })),
  );
});
test("assembly-vue-router near-miss acceptance", { skip }, async (t) => {
  for (const body of [
    "function initialize(to,from,next){to.meta.allowed=true;next();}",
    "async function initialize(to){await Promise.resolve();to.meta.allowed=true;}",
  ]) {
    const changed = source.replace(
      "function initialize(to){to.meta.allowed=true;}",
      body,
    );
    assert.notEqual(changed, source);
    assert.equal((await run(t, changed)).outcome, "passed");
  }
  const changed = source.replace(
    "router.afterEach(audit); router.afterEach(audit);",
    "router.afterEach(audit); router.afterEach(function between(){}); const second=router.afterEach(audit); second();",
  );
  assert.notEqual(changed, source);
  const next = structuredClone(profile);
  next.expectedHooks.splice(
    3,
    2,
    { phase: "afterEach", name: "between" },
    { phase: "afterEach", name: "audit" },
  );
  for (const step of next.navigation) {
    let seen = 0;
    for (const hook of step.hooks)
      if (hook.phase === "afterEach")
        hook.name = seen++ === 0 ? "between" : "audit";
  }
  const report = await run(t, changed, next);
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  assert.deepEqual(
    report.checks[0]!.runtime!.collections[1]!.entries.slice(3).map(
      (e) => e.attributes.name,
    ),
    ["between", "audit"],
  );
});

test("assembly-vue-router prerequisite acceptance", async (t) => {
  const root = await project(
    t,
    "throw Error('Planning executed startup')",
    profile,
    false,
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /installed/,
  );
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  if (!skip) {
    const native = await project(t);
    const file = path.join(native, "node_modules/vue-router/package.json"),
      original = await readFile(file, "utf8");
    try {
      const meta = JSON.parse(original);
      await writeFile(file, JSON.stringify({ ...meta, version: "0.0.0" }));
      const report = await validate(native, { trusted: true });
      assert.equal(report.checks[0]!.status, "unavailable");
      assert.equal(report.outcome, "incomplete");
    } finally {
      await writeFile(file, original);
    }
  }
});

test("assembly-vue-router stale acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true }),
    plan = (await createPlan(root)).plan,
    check = plan.checks[0]!,
    execution = report.checks[0]!.processes[0]!,
    original = JSON.parse(execution.stdout);
  assert.equal(vueRouterEvidence(check, [execution]).status, "passed");
  for (const change of [
    (r: typeof original) => {
      r.runtime.sourceFingerprint = "0".repeat(64);
    },
    (r: typeof original) => {
      r.schemaVersion = 1;
    },
    (r: typeof original) => {
      r.runtime.producer.version = "1.0.0";
    },
    (r: typeof original) => {
      r.runtime.collections[1].entries.pop();
    },
    (r: typeof original) => {
      r.hooks[0].reached = false;
    },
    (r: typeof original) => {
      r.navigation[0].path = "/foreign";
    },
    (r: typeof original) => {
      r.runtime.producer.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.assembly.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.assembly.environment = "foreign";
    },
    (r: typeof original) => {
      r.totalRoutes++;
    },
    (r: typeof original) => {
      r.indices.reverse();
    },
    (r: typeof original) => {
      r.coveredIndices.reverse();
    },
    (r: typeof original) => {
      r.runtime.collections[0].entries[0].key = "foreign";
    },
    (r: typeof original) => {
      r.runtime.collections[0].entries[0].attributes.globalStrict = true;
    },
    (r: typeof original) => {
      r.runtime.collections[1].ordered = false;
    },
    (r: typeof original) => {
      r.runtime.collections[1].kind = "routes";
    },
    (r: typeof original) => {
      r.runtime.collections[1].complete = false;
    },
    (r: typeof original) => {
      r.navigation.pop();
    },
    (r: typeof original) => {
      r.coveredIndices.pop();
    },
    (r: typeof original) => {
      r.probes[0].path = "/foreign";
    },
    (r: typeof original) => {
      r.runtime.collections.push(structuredClone(r.runtime.collections[0]));
    },
  ]) {
    const raw = structuredClone(original);
    change(raw);
    assert.equal(
      vueRouterEvidence(check, [{ ...execution, stdout: JSON.stringify(raw) }])
        .status,
      "inconclusive",
    );
  }
  const next = structuredClone(profile);
  next.expectedHooks.reverse();
  await writeFile(
    path.join(root, "checktrail.vue-router.json"),
    JSON.stringify(next),
  );
  assert.equal((await validate(root, { trusted: true })).outcome, "failed");
});
test("assembly-vue-router empty acceptance", { skip }, async (t) => {
  for (const program of [
    "export function configure(){}",
    source + "\nexport const unused=1;\n",
  ]) {
    const root = await project(t, program);
    if (program.includes("unused")) {
      await writeFile(
        path.join(root, "checktrail.vue-router.json"),
        JSON.stringify({ ...profile, probes: profile.probes.slice(0, 1) }),
      );
    }
    assert.notEqual(
      (await validate(root, { trusted: true })).outcome,
      "passed",
    );
  }
  for (const next of [
    { ...profile, navigation: [] },
    { ...profile, expectedRecords: [] },
    { ...profile, extra: true },
  ]) {
    const root = await project(t, source, next, false);
    await assert.rejects(createPlan(root));
  }
  const replaced = source + "\n";
  const altered = replaced.replace(
    "await Promise.resolve();",
    "router.beforeEach=()=>()=>{}; await Promise.resolve();",
  );
  assert.notEqual(altered, replaced);
  assert.equal((await run(t, altered)).checks[0]!.status, "error");
});

test("assembly-vue-router privacy acceptance", { skip }, async (t) => {
  const root = await project(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout.includes("/catalog"), false);
  for (const detailed of [false, true]) {
    const args = [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        ...(detailed ? ["--detailed"] : []),
      ],
      result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 30000,
      });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, "passed");
    assert.equal(result.stdout.includes("original.router.assembly"), detailed);
    assert.equal(result.stdout.includes("/catalog"), detailed);
    assert.equal(result.stdout.includes(root), detailed);
    const client = new Client(
      { name: "original-router-assembly", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            "--allow-execution",
            ...(detailed ? ["--detailed"] : []),
          ],
          stderr: "pipe",
        }),
      );
      const answer = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(answer.isError, undefined);
      const report = answer.structuredContent as Record<string, unknown>;
      assert.equal(report.outcome, "passed");
      const semantic = (checks: unknown) => {
        const value = structuredClone(checks) as {
          runtime?: { capturedAt?: string };
          processes?: { durationMs?: number; stdout: string }[];
        }[];
        for (const check of value) {
          if (check.runtime) delete check.runtime.capturedAt;
          for (const execution of check.processes ?? []) {
            delete execution.durationMs;
            const raw = JSON.parse(execution.stdout);
            if (raw.runtime) delete raw.runtime.capturedAt;
            execution.stdout = JSON.stringify(raw);
          }
        }
        return value;
      };
      assert.deepEqual(semantic(report.checks), semantic(value.checks));
      assert.equal(JSON.stringify(answer).includes("/catalog"), detailed);
      assert.equal(
        (
          await client.callTool({
            name: "validation_run",
            arguments: { allowExecution: true, detailed: true },
          })
        ).isError,
        true,
      );
    } finally {
      await client.close();
    }
  }
  const client = new Client(
    { name: "original-router-no-trust", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "serve", "--root", root],
        stderr: "pipe",
      }),
    );
    assert.equal(
      (await client.callTool({ name: "validation_run", arguments: {} }))
        .isError,
      true,
    );
  } finally {
    await client.close();
  }
});
test(
  "assembly-vue-router lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const root = await project(
        t,
        source.replace(
          "function verified(to){if(to.meta.allowed!==true)throw Error('Uninitialized navigation');}",
          `async function verified(to){if(to.meta.allowed!==true)throw Error('Uninitialized navigation');const{spawn}=await import('node:child_process'),{writeFile,rename,readFile}=await import('node:fs/promises'),{setTimeout:delay}=await import('node:timers/promises');const child=spawn(process.execPath,['child.mjs',${JSON.stringify(mode)}],{detached:true,stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>{});child.once('close',()=>process.exit(0));for(;;){try{await readFile('child.ready');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}await writeFile('parent.pending',JSON.stringify({parent:process.pid,child:child.pid}));await rename('parent.pending','parent.ready');await new Promise(()=>{});}`,
        ),
      );
      await writeFile(
        path.join(root, "child.mjs"),
        `import{writeFile,rename,access}from'node:fs/promises';import{setTimeout as delay}from'node:timers/promises';await writeFile('child.pending',String(process.pid));await rename('child.pending','child.ready');for(;;){try{await access('worker.release');break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(10)}}if(process.argv[2]==='output'){const bytes='x'.repeat(4095)+'\\n';setInterval(()=>process.stdout.write(bytes),1)}else setInterval(()=>{},1000);`,
      );
      const abort = new AbortController(),
        pending = validate(root, {
          trusted: true,
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          signal: abort.signal,
        });
      let ids: { parent: number; child: number } | undefined;
      try {
        for (let i = 0; i < 300; i++) {
          try {
            ids = JSON.parse(
              await readFile(path.join(root, "parent.ready"), "utf8"),
            );
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await delay(10);
          }
        }
        assert.ok(
          ids,
          "Native beforeResolve and both process descendants must be reached before the control",
        );
        assert.ok(ids.parent > 0 && ids.child > 0 && ids.parent !== ids.child);
        assert.equal(
          Number(await readFile(path.join(root, "child.ready"), "utf8")),
          ids.child,
        );
        process.kill(ids.parent, 0);
        process.kill(ids.child, 0);
        await writeFile(path.join(root, "worker.release"), "go");
        if (mode === "cancel") abort.abort();
        const report = await pending;
        assert.equal(report.outcome, "incomplete");
        const execution = report.checks[0]!.processes[0]!;
        assert.equal(execution.errorCode, undefined);
        assert.equal(execution.cancelled, mode === "cancel");
        assert.equal(execution.timedOut, mode === "timeout");
        assert.equal(execution.truncated, mode === "output");
        if (mode === "output")
          assert.equal(
            Buffer.byteLength(execution.stdout) +
              Buffer.byteLength(execution.stderr),
            1048576,
          );
        for (const pid of [ids.child, ids.parent]) {
          for (let i = 0; i < 100; i++) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
              break;
            }
            await delay(10);
          }
          assert.throws(
            () => process.kill(pid, 0),
            (error: unknown) =>
              (error as NodeJS.ErrnoException).code === "ESRCH",
          );
        }
      } finally {
        abort.abort();
        await pending.catch(() => {});
        for (const file of [
          "parent.ready",
          "child.ready",
          "parent.pending",
          "child.pending",
          "worker.release",
          "child.mjs",
        ])
          await rm(path.join(root, file), { force: true });
      }
      for (const file of ["parent.ready", "child.ready", "worker.release"])
        await assert.rejects(
          access(path.join(root, file)),
          (error: unknown) =>
            (error as NodeJS.ErrnoException).code === "ENOENT",
        );
      const preabort = new AbortController();
      preabort.abort();
      const refused = await validate(root, {
        trusted: true,
        signal: preabort.signal,
      });
      assert.equal(refused.outcome, "incomplete");
      assert.equal(refused.checks[0]!.processes.length, 0);
      await assert.rejects(
        access(path.join(root, "parent.ready")),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
      );
    }
  },
);
test(
  "assembly-vue-router installed acceptance",
  { skip, timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_ROUTER_ASSEMBLY_INSTALLED === "1") {
      const engine = await realpath(
        fileURLToPath(
          new URL("../src/vue-router-assembly.js", import.meta.url),
        ),
      );
      assert.ok(
        engine.includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      return;
    }
    const env = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-vue-router",
    };
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/verify-import-context-package.mjs",
            import.meta.url,
          ),
        ),
      ],
      { env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
  },
);
