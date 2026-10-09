import assert from "node:assert/strict";
import { test } from "node:test";
import {
  access,
  readFile,
  writeFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { runProcess } from "../src/runner.js";
import { projectReport } from "../src/output.js";
import {
  available,
  project,
  source,
  loaderFiles,
} from "./javascript-extensions-fixture.js";
const skip = available
  ? false
  : "Selected native JavaScript extension platform unavailable";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const raw = (report: Awaited<ReturnType<typeof validate>>, id: string) =>
  JSON.parse(report.checks.find((c) => c.id === id)!.processes[0]!.stdout);
const policy = (checks: string[]) =>
  JSON.stringify({ schemaVersion: 1, projects: [{ path: ".", checks }] });
test("javascript-extensions broken acceptance", { skip }, async (t) => {
  for (const [file, text, id] of [
    ["processed.js", source["processed.js"] + "debugger;", "javascript.eslint"],
    [
      "esm.test.mts",
      loaderFiles["esm.test.mts"].replace("actual,42", "actual,43"),
      "javascript.node-test",
    ],
    [
      "cjs.test.cts",
      loaderFiles["cjs.test.cts"].replace("actual,42", "actual,43"),
      "javascript.node-test",
    ],
    [
      "lib/value.ts",
      'export const value: number="wrong";',
      "javascript.vite-library",
    ],
    [
      "lib/value.ts",
      'export const value: string="producer changed";',
      "javascript.vite-library",
    ],
  ]) {
    const root = await project(t, { ...source, [file!]: text! });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed");
    assert.equal(report.checks.find((c) => c.id === id)!.status, "failed");
    if (id === "javascript.eslint") {
      const input = raw(report, id!).files.find(
        (f: { path: string }) => f.path === "processed.js",
      );
      assert.equal(input.results[0].errorCount, 2);
      assert.equal(
        input.participation.events.filter(
          (e: { kind: string }) => e.kind === "parse",
        ).length,
        2,
      );
    }
    if (id === "javascript.node-test")
      assert.equal(report.checks.find((c) => c.id === id)!.tests?.failed, 1);
    if (id === "javascript.vite-library")
      assert.ok(
        report.checks
          .find((c) => c.id === id)!
          .findings?.some((f) => f.ruleId === "TS2322"),
      );
  }
});
test("javascript-extensions fixed acceptance", { skip }, async (t) => {
  const root = await project(t);
  const report = await validate(root, { trusted: true });
  assert.equal(
    report.outcome,
    "passed",
    report.checks
      .map((c) => c.reason + ":" + c.processes[0]?.stderr)
      .join("\n"),
  );
  assert.equal(report.sourceChanged, false);
  assert.equal(report.checks.length, 3);
  assert.deepEqual(report.checks[0]!.tests, {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
  });
  const lint = raw(report, "javascript.eslint");
  assert.ok(
    lint.files.every(
      (f: { participation: { complete: boolean } }) => f.participation.complete,
    ),
  );
  const processed = lint.files.find(
    (f: { path: string }) => f.path === "processed.js",
  );
  assert.equal(processed.participation.events.length, 4);
  assert.equal(
    processed.participation.events.filter(
      (e: { kind: string }) => e.kind === "parse",
    ).length,
    2,
  );
  const build = raw(report, "javascript.vite-library");
  assert.equal(build.complete, true);
  assert.deepEqual(
    build.builds.map(
      (b: { chunks: { exports: string[] }[] }) => b.chunks[0]!.exports,
    ),
    [["value"], ["value"]],
  );
  assert.ok(
    build.resolutions.some(
      (r: { consumer: string }) => r.consumer === path.join(root, "use.ts"),
    ),
  );
  const temporary = path.dirname(
    path.dirname(build.resolutions[0].declaration),
  );
  await assert.rejects(access(temporary));
});
test("javascript-extensions near-miss acceptance", { skip }, async (t) => {
  const root = await project(t, {
    ...source,
    "processed.js":
      "\uFEFFexport const label: number=7;const inert='λ debugger;';",
    "lib/value.ts":
      "// Original valid adjacent label.\nexport const value: number=42;",
  });
  assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  await writeFile(
    path.join(root, "lib/unreachable.ts"),
    "export const unrelated=7;",
  );
  const unsupported = await validate(root, { trusted: true });
  assert.equal(unsupported.outcome, "incomplete");
  assert.equal(
    unsupported.checks.find((c) => c.id === "javascript.vite-library")!.status,
    "inconclusive",
  );
});
test("javascript-extensions prerequisite acceptance", async (t) => {
  const root = await project(t, source, false);
  const planned = (await createPlan(root)).plan;
  assert.equal(
    planned.checks
      .find((c) => c.id === "javascript.eslint")!
      .unavailableReason?.includes("ESLint"),
    true,
  );
  assert.equal(
    planned.checks
      .find((c) => c.id === "javascript.vite-library")!
      .unavailableReason?.includes("installed"),
    true,
  );
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  const config = JSON.parse(source["checktrail.javascript.json"]);
  config.nodeTest.loaders[0].sha256 = "0".repeat(64);
  await writeFile(
    path.join(root, "checktrail.javascript.json"),
    JSON.stringify(config),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /bytes/,
  );
  if (!skip) {
    const native = await project(t);
    for (const [file, id] of [
      ["node_modules/eslint/lib/api.js", "javascript.eslint"],
      ["node_modules/vite/dist/node/index.js", "javascript.vite-library"],
    ]) {
      const target = path.join(native, file!);
      const original = await readFile(target);
      try {
        await writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
        const report = await validate(native, { trusted: true });
        assert.equal(
          report.checks.find((c) => c.id === id)!.status,
          "unavailable",
        );
      } finally {
        await writeFile(target, original);
      }
    }
  }
});
test("javascript-extensions stale acceptance", { skip }, async (t) => {
  const root = await project(t);
  const planned = (await createPlan(root)).plan;
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  for (const check of planned.checks) {
    const execution = report.checks.find((c) => c.id === check.id)!
      .processes[0]!;
    for (const kind of ["source", "configuration", "collection"]) {
      let stdout: string;
      if (check.id === "javascript.node-test") {
        const events = execution.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const last = events.at(-1);
        if (kind === "source") last.manifest.sourceFingerprint = "0".repeat(64);
        if (kind === "configuration")
          last.manifest.loaders[0].sha256 = "0".repeat(64);
        if (kind === "collection")
          events.splice(
            events.findIndex((e) => e.type === "test:summary" && e.data?.file),
            1,
          );
        stdout = events.map((e) => JSON.stringify(e)).join("\n");
      } else {
        const input = JSON.parse(execution.stdout);
        if (check.id === "javascript.eslint") {
          if (kind === "source") input.sourceFingerprint = "0".repeat(64);
          if (kind === "configuration")
            input.configuration.sha256 = "0".repeat(64);
          if (kind === "collection")
            input.files
              .find((f: { path: string }) => f.path === "processed.js")
              .participation.events.splice(1, 1);
        } else {
          if (kind === "source")
            input.manifest.sourceFingerprint = "0".repeat(64);
          if (kind === "configuration") input.versions.vite = "0.0.0";
          if (kind === "collection") input.resolutions = [];
        }
        stdout = JSON.stringify(input);
      }
      assert.equal(
        evaluate(check, [{ ...execution, stdout }], root).status,
        "inconclusive",
        check.id + kind,
      );
    }
  }
  const lint = planned.checks.find((c) => c.id === "javascript.eslint")!;
  await writeFile(
    path.join(root, "processed.js"),
    source["processed.js"] + "debugger;",
  );
  const process = await runProcess(root, lint.commands[0]!, {
    timeoutMs: 10000,
  });
  assert.notEqual(process.exitCode, 0);
  assert.match(process.stderr, /source changed/);
  assert.notEqual(evaluate(lint, [process], root).status, "passed");
});
test("javascript-extensions empty acceptance", { skip }, async (t) => {
  const emptyProcessor = source["eslint.config.mjs"].replace(
    "return [{text,filename:'first.ts'},{text,filename:'second.ts'}]",
    "return []",
  );
  const root = await project(t, {
    ...source,
    "eslint.config.mjs": emptyProcessor,
  });
  let report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  assert.equal(
    report.checks.find((c) => c.id === "javascript.eslint")!.status,
    "inconclusive",
  );
  for (const file of ["cjs.test.cts", "esm.test.mts"] as const)
    await writeFile(
      path.join(root, file),
      loaderFiles[file].replace("test(", "test.skip("),
    );
  report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "inconclusive");
  assert.equal(report.checks[0]!.tests?.skipped, 2);
  const good = await project(t);
  const plan = (await createPlan(good)).plan;
  const passed = await validate(good, { trusted: true });
  for (const check of plan.checks) {
    const execution = passed.checks.find((c) => c.id === check.id)!
      .processes[0]!;
    for (const stdout of [
      "",
      "{}",
      "null",
      execution.stdout + execution.stdout,
    ])
      assert.equal(
        evaluate(check, [{ ...execution, stdout }], good).status,
        "inconclusive",
      );
    assert.equal(evaluate(check, [], good).status, "inconclusive");
  }
});
test("javascript-extensions privacy acceptance", { skip }, async (t) => {
  const root = await project(t);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const library = await validate(root, { trusted: true });
  assert.equal(library.outcome, "passed");
  for (const detailed of [false, true]) {
    const direct = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        "--root",
        root,
        "--trust-project",
        ...(detailed ? ["--detailed"] : []),
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(direct.status, 0, direct.stderr);
    const value = JSON.parse(direct.stdout);
    assert.equal(value.outcome, "passed");
    assert.equal(direct.stdout.includes(root), detailed);
    assert.equal(direct.stdout.includes("__answer__"), false);
    assert.deepEqual(
      value.checks.map((c: { id: string; status: string }) => [c.id, c.status]),
      (
        projectReport(library, detailed) as {
          checks: { id: string; status: string }[];
        }
      ).checks.map((c) => [c.id, c.status]),
    );
    const client = new Client(
      { name: "original-javascript-extensions", version: "1" },
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
      assert.equal(JSON.stringify(answer).includes(root), detailed);
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
    { name: "original-javascript-extensions-no-trust", version: "1" },
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
  "javascript-extensions lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const adapter of ["javascript.node-test", "javascript.eslint"]) {
      for (const mode of ["cancel", "timeout", "output"]) {
        const root = await project(t, {
          ...source,
          "checktrail.json": policy([adapter]),
        });
        const token = adapter + mode;
        const worker = `const fs=require('node:fs');fs.writeFileSync('child.ready',String(process.pid));setInterval(()=>{if(fs.existsSync('worker.release')&&'${mode}'==='output')process.stdout.write('original'.repeat(4096));},10);`;
        await writeFile(path.join(root, "child.cjs"), worker);
        const witness = `const child=spawn(process.execPath,['child.cjs'],{detached:true,stdio:['ignore','inherit','inherit']});while(!fs.existsSync('child.ready'))await delay(10);fs.writeFileSync('parent.pending',JSON.stringify({token:'${token}',parent:process.pid,child:Number(fs.readFileSync('child.ready','utf8'))}));fs.renameSync('parent.pending','parent.ready');await new Promise(()=>{});`;
        if (adapter === "javascript.eslint")
          await writeFile(
            path.join(root, "eslint.config.mjs"),
            `import fs from 'node:fs';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';${witness}`,
          );
        else {
          const hook = `import fs from 'node:fs';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';${witness}`;
          await writeFile(path.join(root, "esm hook.mjs"), hook);
          const profile = JSON.parse(source["checktrail.javascript.json"]);
          profile.nodeTest.loaders = [
            { kind: "import", path: "esm hook.mjs", sha256: hash(hook) },
          ];
          await writeFile(
            path.join(root, "checktrail.javascript.json"),
            JSON.stringify(profile),
          );
        }
        const abort = new AbortController();
        const pending = validate(root, {
          trusted: true,
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          signal: abort.signal,
        });
        void pending.catch(() => {});
        try {
          let ids: { token: string; parent: number; child: number } | undefined;
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
            "Native config/hook and detached child must be reached",
          );
          assert.equal(ids.token, token);
          for (const pid of [ids.parent, ids.child]) process.kill(pid, 0);
          await writeFile(path.join(root, "worker.release"), "go");
          if (mode === "cancel") abort.abort();
          const report = await pending;
          assert.equal(report.outcome, "incomplete");
          const processResult = report.checks[0]!.processes[0]!;
          assert.equal(processResult.cancelled, mode === "cancel");
          assert.equal(processResult.timedOut, mode === "timeout");
          assert.equal(processResult.truncated, mode === "output");
          for (const pid of [ids.parent, ids.child])
            assert.throws(
              () => process.kill(pid, 0),
              (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
            );
        } finally {
          abort.abort();
          await pending.catch(() => {});
        }
      }
    }
    const root = await project(t, {
      ...source,
      "checktrail.json": policy(["javascript.vite-library"]),
      "lib/value.ts":
        "export const value: number=42;\n" +
        Array.from(
          { length: 20000 },
          (_, i) => `export const original${i}:number=${i};`,
        ).join("\n"),
    });
    const planned = await createPlan(root);
    const before = new Set(await readdir(tmpdir()));
    const abort = new AbortController();
    const pending = validate(root, {
      trusted: true,
      signal: abort.signal,
      timeoutMs: 30000,
    });
    void pending.catch(() => {});
    let temporary: string | undefined;
    let pid: number | undefined;
    try {
      for (let i = 0; i < 1000; i++) {
        for (const name of (await readdir(tmpdir())).filter(
          (n) => n.startsWith("checktrail-command-") && !before.has(n),
        )) {
          const dir = path.join(tmpdir(), name);
          try {
            const stage = JSON.parse(
              await readFile(path.join(dir, "library-stage.json"), "utf8"),
            );
            if (stage.sourceFingerprint === planned.source.fingerprint) {
              temporary = dir;
              pid = stage.pid;
              break;
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        if (temporary) break;
        await delay(10);
      }
      assert.ok(temporary, "Native TypeScript producer phase must be reached");
      assert.ok(pid);
      process.kill(pid, 0);
      abort.abort();
      const result = await pending;
      assert.equal(result.outcome, "incomplete");
      assert.equal(result.checks[0]!.processes[0]!.cancelled, true);
      assert.throws(
        () => process.kill(pid!, 0),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
      );
      await assert.rejects(access(temporary));
    } finally {
      abort.abort();
      await pending.catch(() => {});
    }
    await rm(path.join(root, "lib/value.ts"));
    await writeFile(path.join(root, "lib/value.ts"), source["lib/value.ts"]);
    const fresh = (await createPlan(root)).plan.checks[0]!;
    const exhausted = await runProcess(root, fresh.commands[0]!, {
      timeoutMs: 30000,
      maxOutputBytes: 128,
    });
    assert.equal(exhausted.truncated, true);
    assert.equal(
      Buffer.byteLength(exhausted.stdout) + Buffer.byteLength(exhausted.stderr),
      128,
    );
    assert.equal(evaluate(fresh, [exhausted], root).status, "inconclusive");
  },
);
test(
  "javascript-extensions installed acceptance",
  { skip, timeout: 360000 },
  async () => {
    if (process.env.CHECKTRAIL_JAVASCRIPT_EXTENSIONS_INSTALLED === "1") {
      assert.ok(
        (
          await realpath(
            fileURLToPath(new URL("../src/engine.js", import.meta.url)),
          )
        ).includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      return;
    }
    const env = {
      ...process.env,
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "javascript-extensions",
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
      // The nested required profile has a 300-second file budget.
      { env, encoding: "utf8", timeout: 330000, maxBuffer: 4 * 1048576 },
    );
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        error: result.error?.message,
        signal: result.signal,
        stderr: result.stderr?.slice(0, 3000),
      }),
    );
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
  },
);
