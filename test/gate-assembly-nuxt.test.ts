import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  readFile,
  writeFile,
  rm,
  realpath,
  mkdtemp,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { nuxtEvidence } from "../src/nuxt-evidence.js";
import { nuxtAssemblyResultSchema } from "../src/nuxt-assembly-schema.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-nuxt-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned Linux Nuxt/Nitro runtime unavailable";
const outcome = (report: Awaited<ReturnType<typeof run>>) =>
  JSON.stringify({
    outcome: report.outcome,
    reason: report.checks[0]?.reason,
    rules: report.checks[0]?.findings?.map((f) => f.ruleId),
    stdout: report.checks[0]?.processes[0]?.stdout.slice(0, 800),
  });
test("assembly-nuxt broken acceptance", { skip }, async (t) => {
  const incompatible = {
    ...source,
    "server/api/items.get.ts": source["server/api/items.get.ts"]!.replace(
      "id:number",
      "id:string",
    ),
  };
  assert.notDeepEqual(incompatible, source);
  const report = await run(t, incompatible);
  assert.equal(report.outcome, "failed", outcome(report));
  assert.equal(report.checks[0]!.findingsComplete, true);
  assert.deepEqual(
    report.checks[0]!.findings!.map((f) => f.ruleId),
    ["nuxt/assembly-api-types-mismatch", "nuxt/generated-api-consumer"],
  );
  const raw = nuxtAssemblyResultSchema.parse(
    JSON.parse(report.checks[0]!.processes[0]!.stdout),
  );
  assert.deepEqual(raw.types.diagnostics, [2322, 2322, 2322]);
  assert.equal(
    raw.types.apis[0]!.type,
    '{"kind":"array","items":{"kind":"object","properties":[{"name":"id","optional":false,"type":{"kind":"string"}}],"indexes":[]}}',
  );
  assert.equal(raw.requests[0]!.responseBody, '[{"id":1},{"id":2}]');
  const order = {
    ...source,
    "server/middleware/00-initialize.ts":
      source["server/middleware/01-authorize.ts"]!,
    "server/middleware/01-authorize.ts":
      source["server/middleware/00-initialize.ts"]!,
  };
  const failed = await run(t, order);
  assert.equal(failed.outcome, "failed", outcome(failed));
  const reply = JSON.parse(failed.checks[0]!.processes[0]!.stdout);
  assert.equal(failed.checks[0]!.findingsComplete, false);
  assert.equal(reply.requests[0].completion, "error-response");
  assert.equal(reply.requests[0].status, 403);
  assert.equal(reply.requests[1].status, 403);
  assert.equal(reply.requests[3].status, 200);
  assert.equal(reply.requests[0].serverRoute, null);
  assert.ok(
    failed.checks[0]!.findings!.some(
      (f) => f.ruleId === "nuxt/assembly-request-mismatch",
    ),
  );
});
test("assembly-nuxt fixed acceptance", { skip }, async (t) => {
  const report = await run(t),
    check = report.checks[0]!;
  assert.equal(report.outcome, "passed", outcome(report));
  assert.equal(check.findingsComplete, true);
  assert.deepEqual(check.findings, []);
  const raw = nuxtAssemblyResultSchema.parse(
    JSON.parse(check.processes[0]!.stdout),
  );
  assert.deepEqual(raw.counts, [2, 9, 5, 5, 4, 1]);
  assert.deepEqual(raw.types.diagnostics, []);
  assert.ok(raw.types.sourceFiles > 0);
  assert.equal(raw.types.supported, true);
  assert.deepEqual(
    check.runtime!.collections.map((c) => [
      c.kind,
      c.entries.length,
      c.complete,
    ]),
    [
      ["routes", 8, true],
      ["middleware", 10, true],
      ["bindings", 5, true],
    ],
  );
  assert.deepEqual(
    raw.handlers
      .filter((h) => h.route.startsWith("/__nuxt_"))
      .map((h) => h.route),
    ["/__nuxt_error", "/__nuxt_island/**"],
  );
  assert.equal(raw.requests[0]!.method, "GET");
  assert.equal(raw.requests[1]!.method, "POST");
  assert.notEqual(raw.requests[0]!.responseBody, raw.requests[1]!.responseBody);
  assert.equal(JSON.parse(raw.requests[0]!.responseBody).length, 2);
  assert.equal(
    raw.requests[4]!.events.filter((e) => e.phase === "named").length,
    1,
  );
});
test("assembly-nuxt near-miss acceptance", { skip }, async (t) => {
  const next = structuredClone(profile);
  next.requests[1]!.expected.body = '{"created":false}';
  assert.equal(
    (
      await run(
        t,
        {
          ...source,
          "server/api/items.post.ts": source[
            "server/api/items.post.ts"
          ]!.replace("created:true", "created:false"),
        },
        next,
      )
    ).outcome,
    "passed",
  );
  const annotated = {
    ...source,
    "consumer.ts":
      source["consumer.ts"]! +
      "\n// A comment cannot change the native API binding.\n",
  };
  assert.equal((await run(t, annotated)).outcome, "passed");
  const method = structuredClone(profile);
  method.expectedApis[0]!.method = "post";
  method.expectedApis[0]!.type =
    '{"kind":"object","properties":[{"name":"created","optional":false,"type":{"kind":"boolean"}}],"indexes":[]}';
  const consumer =
    "import type {InternalApi}from'nitropack/types';const result:InternalApi['/api/items']['post']={created:true};const created:boolean=result.created;export{created};\n";
  assert.equal(
    (await run(t, { ...source, "consumer.ts": consumer }, method)).outcome,
    "passed",
  );
});
test("assembly-nuxt prerequisite acceptance", async (t) => {
  const untrusted = {
    ...source,
    "nuxt.config.ts":
      "import{writeFileSync}from'node:fs';writeFileSync('imported','ran');throw Error('Planning evaluated Nuxt config');",
  };
  const root = await project(t, untrusted, profile, false);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /installed/,
  );
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  if (!skip) {
    const prepared = await project(t, untrusted),
      check = (await createPlan(prepared)).plan.checks[0]!;
    assert.deepEqual(check.scope, ["nuxt.config.ts"]);
    assert.ok(check.commands[0]!.args[0]!.endsWith("nuxt-assembly-runner.js"));
    await assert.rejects(access(path.join(prepared, "imported")));
    const version = path.join(prepared, "node_modules/h3/package.json"),
      original = await readFile(version, "utf8");
    const json = JSON.parse(original);
    json.version = "0.0.0";
    await writeFile(version, JSON.stringify(json));
    const result = await validate(prepared, { trusted: true });
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.checks[0]!.status, "unavailable");
    assert.equal(
      JSON.parse(result.checks[0]!.processes[0]!.stdout).reason,
      "unsupported-version",
    );
    await assert.rejects(access(path.join(prepared, "imported")));
    await writeFile(version, original);
    const pin = path.join(prepared, "node_modules/h3/dist/index.mjs");
    await writeFile(pin, (await readFile(pin, "utf8")).replace("\n", "\r"));
    const changed = await validate(prepared, { trusted: true });
    assert.equal(changed.checks[0]!.status, "unavailable");
    assert.equal(
      JSON.parse(changed.checks[0]!.processes[0]!.stdout).reason,
      "runtime-byte-mismatch",
    );
    await assert.rejects(access(path.join(prepared, "imported")));
  }
});
test("assembly-nuxt stale acceptance", { skip }, async (t) => {
  const root = await project(t),
    report = await validate(root, { trusted: true, timeoutMs: 60000 }),
    check = (await createPlan(root)).plan.checks[0]!,
    execution = report.checks[0]!.processes[0]!,
    original = JSON.parse(execution.stdout);
  assert.equal(nuxtEvidence(check, [execution]).status, "passed");
  const mutations = [
    (r: typeof original) => {
      r.runtime.sourceFingerprint = "0".repeat(64);
    },
    (r: typeof original) => {
      r.runtime.producer.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.producer.version = "0.0.0";
    },
    (r: typeof original) => {
      r.runtime.assembly.name = "foreign";
    },
    (r: typeof original) => {
      r.runtime.assembly.environment = "foreign";
    },
    (r: typeof original) => {
      r.versions.h3 = "0.0.0";
    },
    (r: typeof original) => {
      r.versions.extra = "unknown";
    },
    (r: typeof original) => {
      r.runtime.collections.push(structuredClone(r.runtime.collections[0]));
    },
    (r: typeof original) => {
      r.runtime.collections[0].complete = false;
    },
    (r: typeof original) => {
      r.runtime.collections[1].ordered = false;
    },
    (r: typeof original) => {
      r.runtime.collections[2].kind = "routes";
    },
    (r: typeof original) => {
      r.runtime.collections[0].entries[0].key = "foreign";
    },
    (r: typeof original) => {
      r.runtime.collections[1].entries.pop();
    },
    (r: typeof original) => {
      r.runtime.collections[2].entries.pop();
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
      r.counts[4]++;
    },
    (r: typeof original) => {
      r.counts[5]++;
    },
    (r: typeof original) => {
      r.requests.pop();
    },
    (r: typeof original) => {
      r.requests[0].path = "/foreign";
    },
    (r: typeof original) => {
      r.requests[0].method = "DELETE";
    },
    (r: typeof original) => {
      r.requests[0].events[0].position = 1000;
    },
    (r: typeof original) => {
      r.types.supported = false;
    },
    (r: typeof original) => {
      r.types.consumers = ["foreign.ts"];
    },
    (r: typeof original) => {
      r.types.apis = [];
    },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(original);
    mutate(raw);
    assert.equal(
      nuxtEvidence(check, [{ ...execution, stdout: JSON.stringify(raw) }])
        .status,
      "inconclusive",
    );
  }
  const next = structuredClone(profile);
  next.expectedHandlers[0]!.source = "project:foreign.ts";
  await writeFile(
    path.join(root, "checktrail.nuxt.json"),
    JSON.stringify(next),
  );
  const fresh = (await createPlan(root)).plan;
  assert.notEqual(fresh.sourceFingerprint, report.sourceFingerprint);
  assert.equal(
    nuxtEvidence(fresh.checks[0]!, [execution]).status,
    "inconclusive",
  );
  assert.equal(
    (await validate(root, { trusted: true, timeoutMs: 60000 })).outcome,
    "failed",
  );
});
test("assembly-nuxt empty acceptance", { skip }, async (t) => {
  for (const change of [
    { requests: [] },
    { expectedPages: [] },
    { expectedHandlers: [] },
    { expectedMiddleware: [] },
    { consumers: [] },
    { expectedApis: [] },
    { environment: "production" },
    { execute: true },
  ])
    await assert.rejects(
      createPlan(await project(t, source, { ...profile, ...change }, false)),
    );
  const any = {
    ...source,
    "server/api/items.get.ts":
      "export default defineEventHandler(()=>[] as any);\n",
  };
  assert.equal((await run(t, any)).outcome, "incomplete");
  const unused = { ...source, "consumer.ts": "export const unrelated=1;\n" };
  assert.equal((await run(t, unused)).outcome, "incomplete");
  const report = await run(t),
    execution = report.checks[0]!.processes[0]!,
    check = (await createPlan(await project(t))).plan.checks[0]!;
  assert.equal(nuxtEvidence(check, []).status, "inconclusive");
  for (const stdout of ["", "{}", "[]", "{", "null"])
    assert.equal(
      nuxtEvidence(check, [{ ...execution, stdout }]).status,
      "inconclusive",
    );
  assert.equal(
    nuxtEvidence(check, [execution, execution]).status,
    "inconclusive",
  );
});
test("assembly-nuxt privacy acceptance", { skip }, async (t) => {
  const root = await project(t),
    cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  await assert.rejects(validate(root, { trusted: false }), /trust/);
  const denied = spawnSync(process.execPath, [cli, "run", "--root", root], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(denied.status, 2);
  assert.equal(denied.stdout.includes("original-server-private"), false);
  for (const detailed of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        ...(detailed ? ["--detailed"] : []),
      ],
      { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1048576 },
    );
    assert.equal(result.status, 0, result.stderr.slice(0, 500));
    const value = JSON.parse(result.stdout);
    assert.equal(value.outcome, "passed");
    assert.equal(result.stdout.includes("original-server-private"), detailed);
    assert.equal(result.stdout.includes("/catalog/:id()"), detailed);
    const client = new Client(
      { name: "original-nuxt-assembly", version: "1" },
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
      assert.equal(
        JSON.stringify(answer).includes("original-server-private"),
        detailed,
      );
      const semantic = (input: unknown): unknown =>
        Array.isArray(input)
          ? input.map(semantic)
          : input !== null && typeof input === "object"
            ? Object.fromEntries(
                Object.entries(input)
                  .filter(
                    ([key]) =>
                      ![
                        "durationMs",
                        "capturedAt",
                        "stdout",
                        "stderr",
                      ].includes(key),
                  )
                  .map(([key, v]) => [key, semantic(v)]),
              )
            : input;
      assert.deepEqual(semantic(report.checks), semantic(value.checks));
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
    { name: "original-nuxt-no-trust", version: "1" },
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
  "assembly-nuxt lifecycle acceptance",
  { skip, timeout: 240000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const childSource =
        "import{writeFileSync,renameSync,existsSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync('child.pending',String(process.pid));renameSync('child.pending','child.ready');const timer=setInterval(()=>{if(existsSync('worker.release')&&process.argv[2]==='output')process.stderr.write('x'.repeat(4095)+'\\n');},1);void timer;\n";
      const middleware = `import{spawn}from'node:child_process';import{writeFileSync,renameSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';export default defineEventHandler(async event=>{if(event.path!=='/api/items')return;process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['lifecycle-child.mjs','${mode}'],{detached:true,stdio:['ignore','ignore','inherit']});while(!existsSync('child.ready'))await delay(10);writeFileSync('parent.pending',JSON.stringify({parent:process.pid,child:child.pid,temp:process.env.CHECKTRAIL_TEMP}));renameSync('parent.pending','parent.ready');await new Promise(()=>{});});\n`;
      const root = await project(t, {
          ...source,
          "server/middleware/00-initialize.ts": middleware,
          "lifecycle-child.mjs": childSource,
        }),
        abort = new AbortController();
      const pending = validate(root, {
        trusted: true,
        timeoutMs: mode === "timeout" ? 45000 : 60000,
        signal: abort.signal,
      });
      let ids: { parent: number; child: number; temp: string } | undefined;
      try {
        // Startup remains inside the execution budget, with time left after reach.
        const deadline = performance.now() + 40000;
        while (performance.now() < deadline) {
          try {
            ids = JSON.parse(
              await readFile(path.join(root, "parent.ready"), "utf8"),
            );
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await delay(20);
          }
        }
        assert.ok(
          ids,
          `Native H3 middleware and both descendants must be reached before ${mode} control`,
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
        const report = await pending,
          execution = report.checks[0]!.processes[0]!;
        assert.equal(report.outcome, "incomplete");
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
        for (const pid of [ids.parent, ids.child]) {
          for (let i = 0; i < 150; i++) {
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
            (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
          );
        }
        await assert.rejects(
          access(ids.temp),
          (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
        );
      } finally {
        abort.abort();
        await pending.catch(() => {});
        for (const file of [
          "parent.ready",
          "child.ready",
          "parent.pending",
          "child.pending",
          "worker.release",
        ])
          await rm(path.join(root, file), { force: true });
      }
      const pre = new AbortController();
      pre.abort();
      const refused = await validate(root, {
        trusted: true,
        signal: pre.signal,
      });
      assert.equal(refused.outcome, "incomplete");
      assert.equal(refused.checks[0]!.processes.length, 0);
      await assert.rejects(access(path.join(root, "parent.ready")));
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "assembly-nuxt installed acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    if (process.env.CHECKTRAIL_NUXT_ASSEMBLY_INSTALLED === "1") {
      const engine = await realpath(
        fileURLToPath(
          new URL("../src/nuxt-assembly-runner.js", import.meta.url),
        ),
      );
      assert.ok(
        engine.includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      return;
    }
    const repository = fileURLToPath(new URL("../../", import.meta.url)),
      temporary = await mkdtemp(
        path.join(tmpdir(), "original-nuxt-installed-"),
      );
    try {
      const [packed] = JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            temporary,
          ],
          { cwd: repository, encoding: "utf8" },
        ),
      );
      const installer = (await import(
        pathToFileURL(
          path.join(repository, "scripts/install-acceptance-package.mjs"),
        ).href
      )) as {
        installAcceptancePackage(
          repository: string,
          tarball: string,
          consumer: string,
        ): Promise<void>;
      };
      const consumer = path.join(temporary, "consumer");
      await installer.installAcceptancePackage(
        repository,
        path.join(temporary, packed.filename),
        consumer,
      );
      const installed = (await import(
        pathToFileURL(
          path.join(
            consumer,
            "node_modules/@stsepelin/checktrail/dist/src/index.js",
          ),
        ).href
      )) as { validate: typeof validate };
      const root = await project(t),
        good = await installed.validate(root, {
          trusted: true,
          timeoutMs: 60000,
        });
      assert.equal(good.outcome, "passed");
      assert.ok(
        good.checks[0]!.processes[0]!.command.args[0]!.includes(consumer),
      );
      await writeFile(
        path.join(root, "server/api/items.get.ts"),
        source["server/api/items.get.ts"]!.replace("id:number", "id:string"),
      );
      assert.equal(
        (await installed.validate(root, { trusted: true, timeoutMs: 60000 }))
          .outcome,
        "failed",
      );
      await writeFile(
        path.join(root, "server/api/items.get.ts"),
        source["server/api/items.get.ts"]!,
      );
      await writeFile(
        path.join(root, "consumer.ts"),
        source["consumer.ts"]! + "\n// Valid installed near miss\n",
      );
      assert.equal(
        (await installed.validate(root, { trusted: true, timeoutMs: 60000 }))
          .outcome,
        "passed",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
