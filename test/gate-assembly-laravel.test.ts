import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { projectReport } from "../src/output.js";
import { laravelEvidence } from "../src/laravel-evidence.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-laravel-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned PHP/Laravel assembly runtime unavailable";
const raw = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.parse(r.checks[0]!.processes[0]!.stdout);
const replace = (before: string, after: string) => {
  assert.equal(source["assembly.php"]!.split(before).length, 2);
  return {
    ...source,
    "assembly.php": source["assembly.php"]!.replace(before, after),
  };
};
test("assembly-laravel broken acceptance", { skip }, async (t) => {
  const r = await run(
    t,
    replace(
      "class AssemblyItem extends AssemblyItemBase {}",
      "class AssemblyItem extends AssemblyItemBase {protected $with=['parent'];}",
    ),
  );
  assert.equal(r.outcome, "failed");
  assert.equal(r.checks[0]!.findingsComplete, true);
  assert.deepEqual(
    r.checks[0]!.findings!.map((f) => f.ruleId),
    ["laravel/assembly-bindings-mismatch", "laravel/assembly-request-mismatch"],
  );
  assert.equal(raw(r).requests[0].status, 500);
  assert.equal(
    raw(r).requests[0].exceptionClass,
    "Illuminate\\Database\\LazyLoadingViolationException",
  );
  assert.equal(raw(r).requests[1].status, 200);
  assert.deepEqual(JSON.parse(raw(r).requests[1].responseBody).armed, [false]);
  const order = {
    ...source,
    "bootstrap/app.php": source["bootstrap/app.php"]!.replace(
      "AssemblyInitialize::class,AssemblyAuthorize::class",
      "AssemblyAuthorize::class,AssemblyInitialize::class",
    ),
  };
  const reversed = await run(t, order);
  assert.equal(reversed.outcome, "failed");
  assert.equal(raw(reversed).requests[0].status, 403);
  const duplicate = await run(
    t,
    replace(
      "$this->app['events']->listen('assembly.saved',AssemblyListener::class.'@handle');",
      "$this->app['events']->listen('assembly.saved',AssemblyListener::class.'@handle');$this->app['events']->listen('assembly.saved',AssemblyListener::class.'@handle');",
    ),
  );
  assert.equal(duplicate.outcome, "failed");
  assert.equal(
    JSON.parse(raw(duplicate).requests[0].responseBody).notifications,
    6,
  );
});
test("assembly-laravel fixed acceptance", { skip }, async (t) => {
  const r = await run(t);
  assert.equal(r.outcome, "passed");
  assert.deepEqual(r.checks[0]!.findings, []);
  assert.equal(r.checks[0]!.findingsComplete, true);
  const response = raw(r),
    body = JSON.parse(response.requests[0].responseBody);
  assert.deepEqual(body.armed, [true, true]);
  assert.deepEqual(body.existing, [
    [true, false],
    [true, false],
  ]);
  assert.deepEqual(
    body.rows.map((x: { score: number; display: string }) => [
      x.score,
      x.display,
    ]),
    [
      [7, "first:7"],
      [9, "second:9"],
    ],
  );
  assert.equal(body.notifications, 4);
  assert.equal(body.scheduled, 1);
  assert.equal(body.selected, 1);
  assert.deepEqual(body.tags, ["basic+extended", "alternate"]);
  assert.equal(body.contextual, "alternate");
  assert.equal(body.method, "bound:basic+extended");
  assert.equal(
    JSON.parse(response.requests[4].responseBody).terminatedBefore,
    4,
  );
  assert.deepEqual(
    response.counts,
    profile.expectedCollections.map((c) => c.entries.length),
  );
  const planned = (await createPlan(await project(t))).plan.checks[0]!
    .commands[0]!;
  assert.ok(planned.args.slice(12).length > 1);
  assert.ok(planned.args.slice(12).every((a) => a.length <= 65536));
});
test("assembly-laravel near-miss acceptance", { skip }, async (t) => {
  const next = structuredClone(profile);
  next.requests = [next.requests[1]!];
  const e = next.expectedCollections[4]!.entries.find(
    (e) => e.attributes.type === "model-defaults",
  )!;
  e.attributes.eagerLoadsHash = createHash("sha256")
    .update(
      JSON.stringify([
        "array",
        [
          [
            ["int", 0],
            ["string", "parent"],
          ],
        ],
      ]),
    )
    .digest("hex");
  const r = await run(
    t,
    replace(
      "class AssemblyItem extends AssemblyItemBase {}",
      "class AssemblyItem extends AssemblyItemBase {protected $with=['parent'];}",
    ),
    next,
  );
  assert.equal(r.outcome, "passed");
  assert.deepEqual(JSON.parse(raw(r).requests[0].responseBody).armed, [false]);
  const later = structuredClone(profile);
  later.clock = "2026-01-01T10:01:00Z";
  later.requests[0]!.expected.body = later.requests[0]!.expected.body.replace(
    '"scheduled":1',
    '"scheduled":0',
  );
  assert.equal((await run(t, source, later)).outcome, "passed");
  assert.equal(
    (
      await run(t, {
        ...source,
        "assembly.php":
          source["assembly.php"]! +
          "\n// Original comment outside native callback source.\n",
      })
    ).outcome,
    "passed",
  );
});
test("assembly-laravel prerequisite acceptance", async (t) => {
  const program = {
    ...source,
    "bootstrap/app.php":
      "<?php file_put_contents(__DIR__.'/../imported','ran');throw new RuntimeException('Planning imported application');",
  };
  const root = await project(t, program, profile, false);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /vendor/,
  );
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  if (!skip) {
    const ready = await project(t, program);
    const check = (await createPlan(ready)).plan.checks[0]!;
    assert.deepEqual(check.scope, ["bootstrap/app.php"]);
    await assert.rejects(access(path.join(ready, "imported")));
    await assert.rejects(access(path.join(ready, "autoload-imported")));
    const autoloadFile = path.join(ready, "vendor/autoload.php");
    const autoloadBytes = await readFile(autoloadFile, "utf8");
    assert.ok(autoloadBytes.startsWith("<?php"));
    await writeFile(
      autoloadFile,
      "<?php file_put_contents(__DIR__.'/../autoload-imported','ran');" +
        autoloadBytes.slice(5),
    );
    const installed = path.join(ready, "vendor/composer/installed.json"),
      original = await readFile(installed, "utf8"),
      metadata = JSON.parse(original);
    metadata.packages.find(
      (p: { name: string }) => p.name === "laravel/framework",
    ).version = "v0.0.0";
    await writeFile(installed, JSON.stringify(metadata));
    const bad = await validate(ready, { trusted: true });
    assert.equal(bad.checks[0]!.status, "unavailable");
    assert.equal(raw(bad).reason, "unsupported-version");
    await assert.rejects(access(path.join(ready, "imported")));
    await assert.rejects(access(path.join(ready, "autoload-imported")));
    await writeFile(installed, original);
    const file = path.join(
        ready,
        "vendor/laravel/framework/src/Illuminate/Container/Container.php",
      ),
      bytes = await readFile(file);
    await writeFile(file, Buffer.concat([bytes, Buffer.from("\n")]));
    const changed = await validate(ready, { trusted: true });
    assert.equal(changed.checks[0]!.status, "unavailable");
    assert.equal(raw(changed).reason, "runtime-byte-mismatch");
    await assert.rejects(access(path.join(ready, "imported")));
    await assert.rejects(access(path.join(ready, "autoload-imported")));
    const equalBytes = Buffer.from(bytes);
    const newline = equalBytes.indexOf(10);
    assert.ok(newline >= 0);
    equalBytes[newline] = 13;
    await writeFile(file, equalBytes);
    const digest = await validate(ready, { trusted: true });
    assert.equal(digest.checks[0]!.status, "unavailable");
    assert.equal(raw(digest).reason, "runtime-byte-mismatch");
    await assert.rejects(access(path.join(ready, "autoload-imported")));
  }
});
test("assembly-laravel stale acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true }),
    check = (await createPlan(root)).plan.checks[0]!,
    execution = report.checks[0]!.processes[0]!,
    original = JSON.parse(execution.stdout);
  assert.equal(laravelEvidence(check, [execution]).status, "passed");
  const mutations: ((r: typeof original) => void)[] = [
    (r) => {
      r.runtime.sourceFingerprint = "0".repeat(64);
    },
    (r) => {
      r.runtime.producer.name = "foreign";
    },
    (r) => {
      r.runtime.producer.version = "1.0.0";
    },
    (r) => {
      r.runtime.assembly.name = "foreign";
    },
    (r) => {
      r.runtime.assembly.environment = "foreign";
    },
    (r) => {
      r.versions.php = "0.0.0";
    },
    (r) => {
      r.versions.extra = "unknown";
    },
    (r) => {
      r.clock = "2026-01-01T10:01:00Z";
    },
    (r) => {
      r.models = [];
    },
    (r) => {
      r.models = ["AssemblyParent"];
    },
    (r) => {
      r.counts[0]++;
      r.counts[1]--;
    },
    (r) => {
      r.entryCount++;
    },
    (r) => {
      r.runtime.collections[0].complete = false;
    },
    (r) => {
      r.runtime.collections[0].ordered = false;
    },
    (r) => {
      r.runtime.collections[1].kind = "routes";
    },
    (r) => {
      r.runtime.collections[0].entries[0].key = "foreign";
    },
    (r) => {
      r.requests[0].host = "foreign.example.test";
    },
    (r) => {
      r.requests[0].port++;
    },
    (r) => {
      r.requests[0].path = "/foreign";
    },
    (r) => {
      r.requests[0].method = "POST";
    },
    (r) => {
      r.requests[0].headers = [];
    },
    (r) => {
      r.requests[0].body = "foreign";
    },
    (r) => {
      r.requests[0].completed = false;
    },
    (r) => {
      r.requests.pop();
    },
    (r) => {
      r.requests[0].responseBody = "λ".repeat(40000);
    },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(original);
    mutate(r);
    const result = laravelEvidence(check, [
      { ...execution, stdout: JSON.stringify(r) },
    ]);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.findingsComplete, false);
  }
  for (const stdout of ["", "{}", "null", execution.stdout + execution.stdout])
    assert.equal(
      laravelEvidence(check, [{ ...execution, stdout }]).status,
      "inconclusive",
    );
  assert.equal(laravelEvidence(check, []).status, "inconclusive");
  assert.equal(
    laravelEvidence(check, [execution, execution]).status,
    "inconclusive",
  );
  const edited = structuredClone(original);
  edited.requests[0].status = 201;
  assert.equal(
    laravelEvidence(check, [{ ...execution, stdout: JSON.stringify(edited) }])
      .status,
    "failed",
  );
});
test("assembly-laravel empty acceptance", { skip }, async (t) => {
  const empty = await run(
    t,
    replace(
      "class AssemblyItem extends AssemblyItemBase {}",
      "class AssemblyItem extends AssemblyItemBase {public function __construct(array $attributes=[]){parent::__construct($attributes);app('router')->setRoutes(new Illuminate\\Routing\\RouteCollection());}}",
    ),
  );
  assert.equal(empty.outcome, "incomplete");
  assert.equal(empty.checks[0]!.findingsComplete, false);
  const opaque = await run(
    t,
    replace(
      "class AssemblyItem extends AssemblyItemBase {}",
      "class AssemblyItem extends AssemblyItemBase {public function getTable(){return 'items';}}",
    ),
  );
  assert.equal(opaque.outcome, "incomplete");
  assert.match(raw(opaque).reason, /overridden/);
  const response = await run(
    t,
    replace(
      "return response()->json(['body'=>$request->getContent(),",
      "return response()->stream(function(){echo 'original';});return response()->json(['body'=>$request->getContent(),",
    ),
  );
  assert.equal(response.outcome, "incomplete");
  assert.match(raw(response).reason, /response class/);
});
test("assembly-laravel privacy acceptance", { skip }, async (t) => {
  const root = await project(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url)),
    library = await validate(root, { trusted: true });
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
  for (const detailed of [false, true]) {
    const args = [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        ...(detailed ? ["--detailed"] : []),
      ],
      direct = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 60000,
      });
    assert.equal(direct.status, 0, direct.stderr);
    const value = JSON.parse(direct.stdout);
    assert.equal(value.outcome, "passed");
    assert.equal(direct.stdout.includes("first:7"), detailed);
    assert.equal(direct.stdout.includes(root), detailed);
    assert.equal(direct.stdout.includes(profile.assembly), detailed);
    assert.deepEqual(
      semantic(value.checks),
      semantic(projectReport(library, detailed).checks),
    );
    const client = new Client(
      { name: "original-laravel", version: "1" },
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
      assert.equal(
        (answer.structuredContent as { outcome: string }).outcome,
        "passed",
      );
      assert.deepEqual(
        semantic((answer.structuredContent as Record<string, unknown>).checks),
        semantic(value.checks),
      );
      assert.equal(JSON.stringify(answer).includes("first:7"), detailed);
      assert.equal(JSON.stringify(answer).includes(root), detailed);
      assert.equal(JSON.stringify(answer).includes(profile.assembly), detailed);
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
    { name: "original-laravel-no-trust", version: "1" },
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
  "assembly-laravel lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const root = await project(t);
      const child = `<?php posix_setsid();file_put_contents('child.ready',(string)getmypid());while(!file_exists('worker.release'))usleep(10000);if('${mode}'==='output')while(true){fwrite(STDOUT,str_repeat('original',4096));usleep(1000);}while(true)usleep(10000);`;
      await writeFile(path.join(root, "child.php"), child);
      const token = "original-" + mode;
      const witness = `$worker=proc_open([PHP_BINARY,base_path('child.php')],[0=>['file','/dev/null','r'],1=>STDOUT,2=>STDERR],$pipes,base_path());while(!is_file(base_path('child.ready')))usleep(10000);file_put_contents(base_path('parent.pending'),json_encode(['token'=>'${token}','parent'=>getmypid(),'child'=>(int)file_get_contents(base_path('child.ready')),'temporary'=>getenv('CHECKTRAIL_TEMP')]));rename(base_path('parent.pending'),base_path('parent.ready'));while(proc_get_status($worker)['running'])usleep(10000);`;
      await writeFile(
        path.join(root, "assembly.php"),
        source["assembly.php"]!.replace(
          "$request->attributes->set('assembly-ready',true);",
          witness + "$request->attributes->set('assembly-ready',true);",
        ),
      );
      const abort = new AbortController(),
        pending = validate(root, {
          trusted: true,
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          signal: abort.signal,
        });
      void pending.catch(() => {});
      let ids:
        | { token: string; parent: number; child: number; temporary: string }
        | undefined;
      try {
        for (let i = 0; i < 300; i++) {
          try {
            ids = JSON.parse(
              await readFile(path.join(root, "parent.ready"), "utf8"),
            );
            break;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await delay(10);
        }
        assert.ok(
          ids,
          "Native HTTP initialization and detached child must be reached",
        );
        assert.equal(ids.token, token);
        assert.notEqual(ids.parent, ids.child);
        for (const pid of [ids.parent, ids.child]) process.kill(pid, 0);
        await writeFile(path.join(root, "worker.release"), "go");
        if (mode === "cancel") abort.abort();
        const r = await pending;
        assert.equal(r.outcome, "incomplete");
        const p = r.checks[0]!.processes[0]!;
        assert.equal(p.errorCode, undefined);
        assert.equal(p.cancelled, mode === "cancel");
        assert.equal(p.timedOut, mode === "timeout");
        assert.equal(p.truncated, mode === "output");
        if (mode === "output")
          assert.equal(
            Buffer.byteLength(p.stdout) + Buffer.byteLength(p.stderr),
            1048576,
          );
        for (const pid of [ids.child, ids.parent]) {
          for (let i = 0; i < 100; i++) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
              break;
            }
            await delay(10);
          }
          assert.throws(
            () => process.kill(pid, 0),
            (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
          );
        }
        await assert.rejects(
          access(ids.temporary),
          (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
        );
      } finally {
        abort.abort();
        await pending.catch(() => {});
        for (const name of [
          "child.php",
          "child.ready",
          "parent.ready",
          "parent.pending",
          "worker.release",
        ])
          await rm(path.join(root, name), { force: true });
      }
      const preabort = new AbortController();
      preabort.abort();
      const refused = await validate(root, {
        trusted: true,
        signal: preabort.signal,
      });
      assert.equal(refused.outcome, "incomplete");
      assert.equal(refused.checks[0]!.processes.length, 0);
    }
  },
);
test(
  "assembly-laravel installed acceptance",
  { skip, timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_LARAVEL_ASSEMBLY_INSTALLED === "1") {
      const engine = await realpath(
        fileURLToPath(new URL("../src/engine.js", import.meta.url)),
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-laravel",
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
      { env, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
  },
);
