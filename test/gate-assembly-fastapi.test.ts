import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { fastapiEvidence } from "../src/fastapi-evidence.js";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-fastapi-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned Python/FastAPI/Starlette/Pydantic assembly runtime unavailable";
test("assembly-fastapi broken acceptance", { skip }, async (t) => {
  const broken = source.replace(
    "app.add_middleware(Authorize)\napp.add_middleware(Initialize,label='root')",
    "app.add_middleware(Initialize,label='root')\napp.add_middleware(Authorize)",
  );
  assert.notEqual(broken, source);
  const report = await run(t, broken);
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.deepEqual(
    report.checks[0]!.findings!.map((f) => f.ruleId),
    [
      "fastapi/assembly-middleware-mismatch",
      ...Array(4).fill("fastapi/assembly-request-mismatch"),
    ],
  );
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.equal(raw.requests[2].status, 403);
  assert.equal(
    raw.requests[2].responseBody,
    '{"detail":"initialization required"}',
  );
});
test("assembly-fastapi fixed acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  const check = report.checks[0]!;
  assert.equal(check.findingsComplete, true);
  assert.deepEqual(check.findings, []);
  assert.deepEqual(
    check.runtime!.collections.map((c) => [
      c.kind,
      c.entries.length,
      c.complete,
    ]),
    [
      ["routes", 13, true],
      ["middleware", 15, true],
      ["listeners", 4, true],
      ["bindings", 1, true],
    ],
  );
  const raw = JSON.parse(check.processes[0]!.stdout);
  assert.equal(raw.routeCount, 9);
  assert.equal(raw.applicationRoutes, 5);
  assert.equal(raw.applicationCount, 3);
  assert.equal(
    raw.requests[2].responseBody,
    '[{"id":1,"enabled":true},{"id":2,"enabled":true}]',
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(root, ".checktrail/lifespan.closed"), "utf8"),
    ),
    ["root.enter", "included.enter", "included.exit", "root.exit"],
  );
  const item = check.runtime!.collections[0]!.entries.find(
    (e) => e.attributes.path === "/v1/catalog/items",
  )!;
  const deps = (item.attributes.dependencies as string[]).map((x) =>
    JSON.parse(x),
  );
  assert.equal(deps.filter((d) => d.call === "app.before").length, 2);
  assert.deepEqual(deps.find((d) => d.call === "app.token").effectiveScopes, [
    "catalog:write",
    "catalog:read",
  ]);
  assert.deepEqual(
    deps.find((d) => d.call === "fastapi.security.oauth2.OAuth2PasswordBearer")
      .security.model.flows.password.scopes,
    { "catalog:read": "Read catalog", "catalog:write": "Write catalog" },
  );
});
test("assembly-fastapi near-miss acceptance", { skip }, async (t) => {
  const next = structuredClone(profile);
  const at = next.expectedRoutes.findIndex(
    (e) => e.path === "/v1/catalog/items",
  );
  next.expectedRoutes.splice(at + 1, 0, {
    ...next.expectedRoutes[at]!,
    method: "POST",
  });
  const report = await run(
    t,
    source + "\nrouter.routes[0].methods.add('POST')\n",
    next,
  );
  assert.equal(report.outcome, "passed");
  const entries = report.checks[0]!.runtime!.collections[0]!.entries;
  assert.deepEqual(
    entries
      .filter((e) => e.attributes.path === "/v1/catalog/items")
      .map((e) => e.attributes.method),
    ["GET", "POST"],
  );
  assert.equal(entries.filter((e) => e.attributes.path === "/items").length, 2);
  assert.equal(
    new Set(
      entries
        .filter((e) => e.attributes.path === "/items")
        .map((e) => e.attributes.scope),
    ).size,
    2,
  );
  const altered = structuredClone(profile);
  altered.requests.push({
    ...altered.requests[3]!,
    protocol: "http",
    method: "GET",
    expected: { status: 404, body: '{"detail":"Not Found"}', messages: [] },
  });
  assert.equal((await run(t, source, altered)).outcome, "passed");
});
test("assembly-fastapi prerequisite acceptance", async (t) => {
  const root = await project(
    t,
    "from pathlib import Path\nPath('imported').write_text('ran')\nraise Exception('Planning ran application')\n",
  );
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.deepEqual(check.scope, ["app.py"]);
  assert.equal(check.commands[0]!.args[0], "-I");
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  if (!skip) {
    const command = check.commands[0]!;
    for (const [reason, args] of [
      ["missing-package", ["-I", "-S", ...command.args.slice(1)]],
      [
        "unsupported-version",
        command.args.map((arg, index) =>
          index === 2
            ? arg.replace("'python':'3.12.13'", "'python':'0.0.0'")
            : arg,
        ),
      ],
      [
        "runtime-byte-mismatch",
        command.args.map((arg, index) =>
          index === 2 ? arg.replace('"bytes":183840', '"bytes":183841') : arg,
        ),
      ],
    ] as const) {
      const execution = spawnSync("python3", [...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(execution.status, 3, execution.stderr);
      assert.equal(JSON.parse(execution.stdout).reason, reason);
      await assert.rejects(access(path.join(root, "imported")));
    }
  }
});
test("assembly-fastapi stale acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true }),
    check = (await createPlan(root)).plan.checks[0]!,
    execution = report.checks[0]!.processes[0]!,
    original = JSON.parse(execution.stdout);
  assert.equal(fastapiEvidence(check, [execution]).status, "passed");
  for (const change of [
    (r: typeof original) => {
      r.version = 1;
    },
    (r: typeof original) => {
      r.versions.python = "0.0.0";
    },
    (r: typeof original) => {
      r.runtime.sourceFingerprint = "0".repeat(64);
    },
    (r: typeof original) => {
      r.runtime.producer.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.producer.version = "1.0.0";
    },
    (r: typeof original) => {
      r.runtime.assembly.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.assembly.environment = "foreign";
    },
    (r: typeof original) => {
      r.applicationCount++;
    },
    (r: typeof original) => {
      r.applicationRoutes++;
    },
    (r: typeof original) => {
      r.routeCount++;
    },
    (r: typeof original) => {
      r.middlewareCount++;
    },
    (r: typeof original) => {
      r.lifespanCount++;
    },
    (r: typeof original) => {
      r.bindingCount++;
    },
    (r: typeof original) => {
      r.runtime.collections[0].entries[0].key = "foreign";
    },
    (r: typeof original) => {
      r.runtime.collections[1].entries.pop();
    },
    (r: typeof original) => {
      r.runtime.collections[2].ordered = false;
    },
    (r: typeof original) => {
      r.runtime.collections[3].kind = "routes";
    },
    (r: typeof original) => {
      r.runtime.collections[0].complete = false;
    },
    (r: typeof original) => {
      r.requests.pop();
    },
    (r: typeof original) => {
      r.requests[0].host = "foreign.test";
    },
    (r: typeof original) => {
      r.requests[0].headers = [];
    },
    (r: typeof original) => {
      r.runtime.collections.push(structuredClone(r.runtime.collections[0]));
    },
  ]) {
    const raw = structuredClone(original);
    change(raw);
    assert.equal(
      fastapiEvidence(check, [{ ...execution, stdout: JSON.stringify(raw) }])
        .status,
      "inconclusive",
    );
  }
  const next = structuredClone(profile);
  next.expectedMiddleware.reverse();
  await writeFile(
    path.join(root, "checktrail.fastapi.json"),
    JSON.stringify(next),
  );
  const fresh = (await createPlan(root)).plan;
  assert.notEqual(fresh.sourceFingerprint, report.sourceFingerprint);
  assert.equal(
    fastapiEvidence(fresh.checks[0]!, [execution]).status,
    "inconclusive",
  );
  assert.equal((await validate(root, { trusted: true })).outcome, "failed");
});
test("assembly-fastapi empty acceptance", { skip }, async (t) => {
  for (const program of [
    "from fastapi import FastAPI\napp=FastAPI()\n",
    source + "\napp.mount('/opaque',lambda scope,receive,send:None)\n",
    source + "\napp.router.routes.clear()\n",
    source + "\napp.router._low_priority_routes.append(object())\n",
  ]) {
    assert.notEqual((await run(t, program)).outcome, "passed");
  }
  for (const configuration of [
    { ...profile, requests: [] },
    { ...profile, expectedRoutes: [] },
    { ...profile, expectedLifespan: [] },
    { ...profile, execute: true },
  ])
    await assert.rejects(createPlan(await project(t, source, configuration)));
  const report = await run(t),
    check = (await createPlan(await project(t))).plan.checks[0]!;
  assert.equal(fastapiEvidence(check, []).status, "inconclusive");
  assert.equal(
    fastapiEvidence(check, [
      { ...report.checks[0]!.processes[0]!, stdout: "{}" },
    ]).status,
    "inconclusive",
  );
});
test("assembly-fastapi privacy acceptance", { skip }, async (t) => {
  const root = await project(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout.includes("/v1/catalog/items"), false);
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
    assert.equal(result.stdout.includes("original.fastapi.assembly"), detailed);
    assert.equal(result.stdout.includes("/v1/catalog/items"), detailed);
    assert.equal(result.stdout.includes(root), detailed);
    const client = new Client(
      { name: "original-fastapi-assembly", version: "1" },
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
      const semantic = (input: unknown): unknown => {
        if (Array.isArray(input)) return input.map(semantic);
        if (input !== null && typeof input === "object")
          return Object.fromEntries(
            Object.entries(input)
              .filter(([key]) => key !== "durationMs" && key !== "capturedAt")
              .map(([key, value]) => {
                if (
                  key === "stdout" &&
                  typeof value === "string" &&
                  value.startsWith("{")
                ) {
                  try {
                    return [key, JSON.stringify(semantic(JSON.parse(value)))];
                  } catch {
                    /* Plain tool output remains unchanged. */
                  }
                }
                return [key, semantic(value)];
              }),
          );
        return input;
      };
      assert.deepEqual(semantic(report.checks), semantic(value.checks));
      assert.equal(
        JSON.stringify(answer).includes("/v1/catalog/items"),
        detailed,
      );
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
    { name: "original-fastapi-no-trust", version: "1" },
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
  "assembly-fastapi lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const childSource = String.raw`import os,pathlib,time,sys
pathlib.Path('child.pending').write_text(str(os.getpid()));os.replace('child.pending','child.ready')
while not pathlib.Path('worker.release').exists():time.sleep(.01)
if sys.argv[1]=='output':
    while True: print('x'*4095,flush=True);time.sleep(.001)
else:
    while True: time.sleep(1)
`;
      const witness = String.raw`        if scope['type']=='http':
            import asyncio,subprocess,sys,pathlib,os,json,signal
            child=subprocess.Popen([sys.executable,'-I','child.py','MODE'],start_new_session=True)
            signal.signal(signal.SIGTERM,lambda *_:None)
            while not pathlib.Path('child.ready').exists(): await asyncio.sleep(.01)
            pathlib.Path('parent.pending').write_text(json.dumps({'parent':os.getpid(),'child':child.pid}));os.replace('parent.pending','parent.ready')
            while child.poll() is None: await asyncio.sleep(.01)
            sys.exit(0)
`;
      const root = await project(
        t,
        source.replace(
          "        await self.app(scope,receive,send)",
          witness.replace("MODE", mode) +
            "        await self.app(scope,receive,send)",
        ),
      );
      await writeFile(path.join(root, "child.py"), childSource);
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
          "Native ASGI initialization middleware and both process descendants must be reached before the control",
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
          "child.py",
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
  "assembly-fastapi installed acceptance",
  { skip, timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_FASTAPI_ASSEMBLY_INSTALLED === "1") {
      const engine = await realpath(
        fileURLToPath(
          new URL("../src/fastapi-assembly-runner.js", import.meta.url),
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-fastapi",
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
