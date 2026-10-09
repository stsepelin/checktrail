import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { djangoEvidence } from "../src/django-evidence.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-django-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned Python/Django/asgiref assembly runtime unavailable";
test("assembly-django broken acceptance", { skip }, async (t) => {
  const broken = {
    ...source,
    "extras/apps.py": source["extras/apps.py"]!.replace(
      "dispatch_uid='catalog.notice'",
      "dispatch_uid='extras.notice'",
    ),
  };
  assert.notDeepEqual(broken, source);
  const report = await run(t, broken);
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.deepEqual(
    report.checks[0]!.findings!.map((f) => f.ruleId),
    [
      "django/assembly-signals-mismatch",
      "django/assembly-request-mismatch",
      "django/assembly-request-mismatch",
    ],
  );
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.equal(JSON.parse(raw.requests[0].responseBody).notifications, 4);
  assert.equal(raw.requests[0].events.length, 2);
  assert.deepEqual(raw.requests[0].events[0].receivers, [
    "project_signals.notice",
    "project_signals.notice",
  ]);
  const order = {
    ...source,
    "settings.py": source["settings.py"]!.replace(
      "'middleware.Initialize','middleware.Authorize'",
      "'middleware.Authorize','middleware.Initialize'",
    ),
  };
  const failed = await run(t, order);
  assert.equal(failed.outcome, "failed");
  const reply = JSON.parse(failed.checks[0]!.processes[0]!.stdout).requests[0];
  assert.equal(reply.status, 403);
  assert.equal(reply.responseBody, '{"detail": "initialization required"}');
});
test("assembly-django fixed acceptance", { skip }, async (t) => {
  const report = await run(t);
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
      ["routes", 5, true],
      ["middleware", 11, true],
      ["listeners", 1, true],
      ["bindings", 2, true],
    ],
  );
  const raw = JSON.parse(check.processes[0]!.stdout);
  assert.equal(raw.visitedNodes, 7);
  assert.equal(raw.resolverNodes, 2);
  for (const [i, n] of [
    [0, 7],
    [1, 8],
  ]) {
    const reply = JSON.parse(raw.requests[i!].responseBody);
    assert.equal(reply.items.length, 2);
    assert.equal(reply.notifications, 2);
    assert.equal(reply.itemId, n);
    assert.equal(reply.mode, "leaf");
    assert.deepEqual(reply.view, ["first", "second"]);
  }
  assert.equal(raw.requests[3].responseBody, "native second+first");
  assert.equal(raw.requests[4].status, 409);
  assert.deepEqual(JSON.parse(raw.requests[2].responseBody).setup, [
    "catalog.ready",
    "extras.ready",
  ]);
  assert.equal(
    check.runtime!.collections[1]!.entries[4]!.attributes.constructed,
    false,
  );
});
test("assembly-django near-miss acceptance", { skip }, async (t) => {
  const next = structuredClone(profile);
  next.expectedSignals.push({
    ...next.expectedSignals[0]!,
    position: 1,
    receiver: "project_signals.second",
    dispatchUid: '["string","extras.second"]',
  });
  for (const request of next.requests.slice(0, 2)) {
    request.expected.body = request.expected.body.replace(
      '"notifications": 2',
      '"notifications": 4',
    );
    for (const event of request.expected.events) {
      event.receivers.push("project_signals.second");
      event.errors.push(false);
    }
  }
  const program = {
    ...source,
    "project_signals.py":
      source["project_signals.py"]! +
      '\ndef second(sender,**kwargs):notifications.append(kwargs["row"])\n',
    "extras/apps.py": source["extras/apps.py"]!.replace(
      "from project_signals import changed,notice,setup",
      "from project_signals import changed,notice,setup,second",
    ).replace(
      "changed.connect(notice,weak=False,dispatch_uid='catalog.notice')",
      "changed.connect(second,weak=False,dispatch_uid='extras.second')",
    ),
  };
  assert.equal((await run(t, program, next)).outcome, "passed");
  const weak = {
    ...source,
    "project_signals.py":
      source["project_signals.py"]! +
      "\nimport gc\ndef temporary(sender,**kwargs):raise RuntimeError('Dead weak callback ran')\nchanged.connect(temporary)\ndel temporary\ngc.collect()\n",
  };
  assert.equal((await run(t, weak)).outcome, "passed");
});
test("assembly-django prerequisite acceptance", async (t) => {
  const root = await project(t, {
      ...source,
      "settings.py":
        "from pathlib import Path\nPath('imported').write_text('ran')\nraise Exception('Planning executed settings')\n",
    }),
    check = (await createPlan(root)).plan.checks[0]!;
  assert.deepEqual(check.scope, ["settings.py"]);
  assert.equal(check.commands[0]!.args[0], "-I");
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  if (!skip) {
    const command = check.commands[0]!;
    for (const [reason, args] of [
      ["missing-package", ["-I", "-S", ...command.args.slice(1)]],
      [
        "unsupported-version",
        command.args.map((a, i) =>
          i === 2 ? a.replace("'python':'3.12.13'", "'python':'0.0.0'") : a,
        ),
      ],
      [
        "runtime-byte-mismatch",
        command.args.map((a, i) =>
          i === 2 ? a.replace('"bytes":' + 799, '"bytes":800') : a,
        ),
      ],
    ] as const) {
      const result = spawnSync("python3", [...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(result.status, 3, result.stderr);
      assert.equal(JSON.parse(result.stdout).reason, reason);
      await assert.rejects(access(path.join(root, "imported")));
    }
  }
});
test("assembly-django stale acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true }),
    check = (await createPlan(root)).plan.checks[0]!,
    execution = report.checks[0]!.processes[0]!,
    original = JSON.parse(execution.stdout);
  assert.equal(djangoEvidence(check, [execution]).status, "passed");
  for (const mutate of [
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
      r.visitedNodes++;
    },
    (r: typeof original) => {
      r.resolverNodes++;
    },
    (r: typeof original) => {
      r.counts[0]++;
    },
    (r: typeof original) => {
      r.counts[1]++;
    },
    (r: typeof original) => {
      r.counts[2]++;
    },
    (r: typeof original) => {
      r.counts[3]++;
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
      r.requests[0].headers = [["x-extra", "yes"]];
    },
    (r: typeof original) => {
      r.runtime.collections.push(structuredClone(r.runtime.collections[0]));
    },
  ]) {
    const raw = structuredClone(original);
    mutate(raw);
    assert.equal(
      djangoEvidence(check, [{ ...execution, stdout: JSON.stringify(raw) }])
        .status,
      "inconclusive",
    );
  }
  const next = structuredClone(profile);
  next.expectedApps.reverse();
  await writeFile(
    path.join(root, "checktrail.django.json"),
    JSON.stringify(next),
  );
  const fresh = (await createPlan(root)).plan;
  assert.notEqual(fresh.sourceFingerprint, report.sourceFingerprint);
  assert.equal(
    djangoEvidence(fresh.checks[0]!, [execution]).status,
    "inconclusive",
  );
  assert.equal((await validate(root, { trusted: true })).outcome, "failed");
});
test("assembly-django empty acceptance", { skip }, async (t) => {
  for (const program of [
    { ...source, "urls.py": source["urls.py"]! + "\nurlpatterns.clear()\n" },
    {
      ...source,
      "urls.py": source["urls.py"]! + "\nurlpatterns.append(object())\n",
    },
    {
      ...source,
      "settings.py": source["settings.py"]!.replace(
        "['catalog','extras.apps.ExtrasConfig']",
        "[]",
      ),
    },
  ])
    assert.notEqual((await run(t, program)).outcome, "passed");
  for (const config of [
    { ...profile, requests: [] },
    { ...profile, expectedRoutes: [] },
    { ...profile, expectedApps: [] },
    { ...profile, signals: [] },
    { ...profile, execute: true },
  ])
    await assert.rejects(createPlan(await project(t, source, config)));
  const report = await run(t),
    check = (await createPlan(await project(t))).plan.checks[0]!;
  assert.equal(djangoEvidence(check, []).status, "inconclusive");
  assert.equal(
    djangoEvidence(check, [
      { ...report.checks[0]!.processes[0]!, stdout: "{}" },
    ]).status,
    "inconclusive",
  );
});

test("assembly-django privacy acceptance", { skip }, async (t) => {
  const root = await project(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout.includes("/web/items/7/"), false);
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
    assert.equal(result.stdout.includes("original.django.assembly"), detailed);
    assert.equal(result.stdout.includes("/web/items/7/"), detailed);
    assert.equal(result.stdout.includes(root), detailed);
    const client = new Client(
      { name: "original-django-assembly", version: "1" },
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
      assert.equal(JSON.stringify(answer).includes("/web/items/7/"), detailed);
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
    { name: "original-django-no-trust", version: "1" },
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
  "assembly-django lifecycle acceptance",
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
      const witness = String.raw`        import subprocess,sys,pathlib,os,json,signal,time
        child=subprocess.Popen([sys.executable,'-I','child.py','MODE'],start_new_session=True)
        signal.signal(signal.SIGTERM,lambda *_:None)
        while not pathlib.Path('child.ready').exists():time.sleep(.01)
        pathlib.Path('parent.pending').write_text(json.dumps({'parent':os.getpid(),'child':child.pid}));os.replace('parent.pending','parent.ready')
        while child.poll() is None:time.sleep(.01)
        sys.exit(0)
`;
      const root = await project(t, {
        ...source,
        "middleware.py": source["middleware.py"]!.replace(
          "        request.initialized=True",
          witness.replace("MODE", mode) + "        request.initialized=True",
        ),
      });
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
          "Native WSGI initialization middleware and both process descendants must be reached before the control",
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
  "assembly-django installed acceptance",
  { skip, timeout: 120000 },
  async () => {
    if (process.env.CHECKTRAIL_DJANGO_ASSEMBLY_INSTALLED === "1") {
      const engine = await realpath(
        fileURLToPath(
          new URL("../src/django-assembly-runner.js", import.meta.url),
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-django",
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
