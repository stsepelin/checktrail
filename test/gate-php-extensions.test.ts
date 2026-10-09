import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { access, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { runProcess } from "../src/runner.js";
import { projectReport } from "../src/output.js";
import {
  phpOriginal,
  phpReceipt,
  phpAtomic,
  phpExtensionsSkip as skip,
  phpCacheNames,
  phpProxy,
} from "./php-extensions-fixture.js";
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
type Native = {
  manifest: { sourceFingerprint: string; toolPins: Array<{ sha256: string }> };
  runtime: {
    extensions: Array<{ version: string }>;
    artifacts: Array<{ sha256: string }>;
  };
  complete: boolean;
  inputsStable: boolean;
  failure: string | null;
  classes: Array<{ class: string; path: string; sha256: string }>;
  models: Array<{
    requestedClass: string;
    class: string;
    parents: Array<{ class: string; path: string; sha256: string }>;
    defaults: { keyType: string };
    probes: Array<{
      attribute: string;
      origin: { class: string; path: string; sha256: string };
      value: { type: string; value: unknown };
    }>;
  }>;
};
test(
  "php-extensions broken acceptance",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t);
    const report = await validate(f.root, f.options);
    assert.equal(report.outcome, "failed");
    assert.deepEqual(
      report.checks.map((c) => c.status),
      ["failed", "failed", "failed"],
    );
    assert.equal(report.sourceChanged, false);
    const c = report.checks[2]!;
    assert.equal(c.findingsComplete, true);
    assert.deepEqual(
      c.findings?.map((f) => [f.ruleId, f.file]),
      [
        ["php.accessor", "Item.php"],
        ["php.accessor", "Item.php"],
      ],
    );
    assert.equal((await phpReceipt(c)).models[0]!.probes.length, 2);
    assert.ok(
      report.checks[0]!.findings?.some(
        (f) => f.file === "generated/Proxy.php" && f.ruleId === "return.type",
      ),
    );
    assert.ok(
      report.checks[1]!.findings?.some((f) => f.ruleId === "single_quote"),
    );
  },
);
test("php-extensions fixed acceptance", { skip, timeout: 90000 }, async (t) => {
  const f = await phpOriginal(t, { fixed: true });
  const report = await validate(f.root, f.options);
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  assert.equal(report.sourceChanged, false);
  const r = await phpReceipt(report.checks[2]!);
  assert.equal(r.complete, true);
  assert.equal(r.classes.length, 2);
  assert.deepEqual(
    r.models[0]!.probes.map((p) => p.value),
    [
      { type: "string", value: "Nova Vale" },
      { type: "string", value: "Nova North" },
    ],
  );
  assert.deepEqual(
    report.checks[2]!.tools?.map((t) => [t.name, t.version]),
    [
      ["php", "8.5.6"],
      ["phpstan", "2.2.14"],
      ["larastan", "3.12.3"],
      ["php-cs-fixer", "3.95.27"],
      ["laravel", "13.32.0"],
    ],
  );
});
test(
  "php-extensions near-miss acceptance",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t, { fixed: true });
    f.config.models[0]!.probes[0]!.attributes = { first: "Nova", last: "" };
    f.config.models[0]!.probes[0]!.expected.value = "Nova ";
    await phpAtomic(
      path.join(f.root, "checktrail.php.json"),
      JSON.stringify(f.config),
    );
    assert.equal((await validate(f.root, f.options)).outcome, "passed");
    f.config.models[0]!.defaults.keyType = "int";
    await phpAtomic(
      path.join(f.root, "checktrail.php.json"),
      JSON.stringify(f.config),
    );
    const report = await validate(f.root, f.options);
    assert.deepEqual(
      report.checks[2]!.findings?.map((f) => f.ruleId),
      ["php.model-defaults"],
    );
    assert.equal(report.checks[2]!.findingsComplete, true);
  },
);
test(
  "php-extensions prerequisite acceptance",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t, { fixed: true, checks: ["php.extensions"] });
    const original = f.config.classes[1]!.sha256;
    f.config.classes[1]!.sha256 = "0".repeat(64);
    await phpAtomic(
      path.join(f.root, "checktrail.php.json"),
      JSON.stringify(f.config),
    );
    assert.match(
      (await createPlan(f.root)).plan.checks[0]!.unavailableReason!,
      /source bytes changed/,
    );
    f.config.classes[1]!.sha256 = original;
    f.config.nativeExtensions.pop();
    await phpAtomic(
      path.join(f.root, "checktrail.php.json"),
      JSON.stringify(f.config),
    );
    assert.match(
      (await createPlan(f.root)).plan.checks[0]!.unavailableReason!,
      /complete selected native/,
    );
    f.config.nativeExtensions.push("zlib");
    await phpAtomic(
      path.join(f.root, "checktrail.php.json"),
      JSON.stringify(f.config),
    );
    const nativeCase = await phpOriginal(t, {
      fixed: true,
      checks: ["php.extensions"],
    });
    const nativeBootstrap = path.join(nativeCase.root, "bootstrap/app.php");
    await phpAtomic(
      nativeBootstrap,
      (await readFile(nativeBootstrap, "utf8")).replace(
        "<?php ",
        "<?php file_put_contents('closure.marker', 'must remain absent'); ",
      ),
    );
    const nativeCheck = (
      await createPlan(nativeCase.root, { environment: nativeCase.environment })
    ).plan.checks[0]!;
    const alteredArgs = [...nativeCheck.commands[0]!.args];
    const alteredManifest = JSON.parse(alteredArgs.at(-1)!);
    alteredManifest.config.nativeExtensions.pop();
    alteredArgs[alteredArgs.length - 1] = JSON.stringify(alteredManifest);
    const altered = await runProcess(
      nativeCase.root,
      { ...nativeCheck.commands[0]!, args: alteredArgs },
      {
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        environment: nativeCase.environment,
      },
    );
    assert.equal(altered.exitCode, 3, altered.stderr);
    assert.match(altered.stdout, /Native PHP extension closure differs/);
    await assert.rejects(access(path.join(nativeCase.root, "closure.marker")));
    const bootstrap = path.join(f.root, "bootstrap/app.php");
    await phpAtomic(
      bootstrap,
      "<?php file_put_contents('imported.marker','must remain absent'); throw new RuntimeException();",
    );
    const tool = path.join(f.root, "vendor/larastan/larastan/bootstrap.php");
    await phpAtomic(
      tool,
      (await readFile(tool, "utf8")) +
        "\n// original changed selected native API\n",
    );
    const report = await validate(f.root, f.options);
    assert.equal(report.checks[0]!.status, "unavailable");
    assert.match(
      report.checks[0]!.reason,
      /Native PHP tool version or bytes changed/,
    );
    await assert.rejects(access(path.join(f.root, "imported.marker")));
  },
);
test("php-extensions stale acceptance", { skip, timeout: 90000 }, async (t) => {
  const f = await phpOriginal(t, {
    fixed: true,
    checks: ["php.extensions"],
    excludedProxy: true,
  });
  const check = (await createPlan(f.root, { environment: f.environment })).plan
    .checks[0]!;
  const passed = await validate(f.root, f.options);
  assert.equal(passed.outcome, "passed");
  const execution = passed.checks[0]!.processes[0]!;
  for (const modify of [
    (r: Native) => {
      r.manifest.sourceFingerprint = "0".repeat(64);
    },
    (r: Native) => {
      r.inputsStable = false;
    },
    (r: Native) => {
      r.runtime.extensions[0]!.version = "unknown";
    },
    (r: Native) => {
      r.runtime.artifacts[0]!.sha256 = "0".repeat(64);
    },
    (r: Native) => {
      r.classes[0]!.sha256 = "0".repeat(64);
    },
    (r: Native) => {
      r.models[0]!.parents[0]!.path = "outside.php";
    },
    (r: Native) => {
      r.models[0]!.probes[0]!.origin.path = "generated/Proxy.php";
    },
  ]) {
    const r = JSON.parse(execution.stdout);
    modify(r);
    assert.equal(
      evaluate(check, [{ ...execution, stdout: JSON.stringify(r) }], f.root)
        .status,
      "inconclusive",
    );
  }
  const changed = JSON.parse(execution.stdout) as Native;
  changed.manifest.toolPins[0]!.sha256 = "0".repeat(64);
  const args = [...check.commands[0]!.args];
  args[args.length - 1] = JSON.stringify(changed.manifest);
  assert.equal(
    evaluate(
      { ...check, commands: [{ ...check.commands[0]!, args }] },
      [{ ...execution, stdout: JSON.stringify(changed) }],
      f.root,
    ).status,
    "inconclusive",
  );
  assert.equal(
    evaluate({ ...check, id: "php.phpstan" }, [execution], f.root).status,
    "inconclusive",
  );
  await phpAtomic(
    path.join(f.root, f.proxyPath),
    phpProxy + "// original changed excluded bytes\n",
  );
  const old = await runProcess(f.root, check.commands[0]!, {
    timeoutMs: 10000,
    maxOutputBytes: 65536,
    environment: f.environment,
  });
  assert.equal(old.exitCode, 3, old.stderr);
  assert.match(old.stdout, /bound input bytes changed/);
  assert.equal(evaluate(check, [old], f.root).status, "unavailable");
});
test("php-extensions empty acceptance", { skip, timeout: 90000 }, async (t) => {
  const f = await phpOriginal(t, { fixed: true, checks: ["php.extensions"] });
  const check = (await createPlan(f.root, { environment: f.environment })).plan
    .checks[0]!;
  const report = await validate(f.root, f.options);
  assert.equal(report.outcome, "passed");
  const execution = report.checks[0]!.processes[0]!;
  for (const stdout of ["", "{}", "null", execution.stdout + execution.stdout])
    assert.equal(
      evaluate(check, [{ ...execution, stdout }], f.root).status,
      "inconclusive",
    );
  assert.equal(evaluate(check, [], f.root).status, "inconclusive");
  for (const modify of [
    (r: Native) => {
      r.models = [];
    },
    (r: Native) => {
      r.classes = [];
    },
    (r: Native) => {
      r.classes[1] = r.classes[0]!;
    },
    (r: Native) => {
      r.models[0]!.probes.pop();
    },
    (r: Native) => {
      r.models[0]!.parents.pop();
    },
    (r: Native) => {
      r.models[0]!.requestedClass = "unknown";
    },
  ]) {
    const r = JSON.parse(execution.stdout);
    modify(r);
    assert.equal(
      evaluate(check, [{ ...execution, stdout: JSON.stringify(r) }], f.root)
        .status,
      "inconclusive",
    );
  }
  const r = JSON.parse(execution.stdout);
  r.complete = false;
  assert.equal(
    evaluate(check, [{ ...execution, stdout: JSON.stringify(r) }], f.root)
      .status,
    "error",
  );
  assert.equal(
    evaluate(check, [{ ...execution, exitCode: 2 }], f.root).status,
    "error",
  );
  const bootstrap = path.join(f.root, "bootstrap/app.php");
  await phpAtomic(
    bootstrap,
    "<?php throw new RuntimeException('original bootstrap incomplete');\n",
  );
  assert.equal((await validate(f.root, f.options)).checks[0]!.status, "error");
});
test(
  "php-extensions privacy acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await phpOriginal(t, { fixed: true });
    await assert.rejects(
      validate(f.root, { trusted: false }),
      /operator trust/,
    );
    const library = await validate(f.root, f.options);
    assert.equal(library.outcome, "passed");
    const grants = phpCacheNames.flatMap((n) => ["--allow-env", n]);
    const env: Record<string, string> = {
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap(
          (name) =>
            process.env[name] === undefined ? [] : [[name, process.env[name]!]],
        ),
      ),
      ...f.environment,
    };
    for (const detailed of [false, true]) {
      const args = [
        "--root",
        f.root,
        ...grants,
        ...(detailed ? ["--detailed"] : []),
      ];
      const direct = spawnSync(
        process.execPath,
        [cli, "run", ...args, "--trust-project"],
        { env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(direct.status, 0, direct.stderr);
      const value = JSON.parse(direct.stdout);
      assert.equal(value.outcome, "passed");
      assert.equal(direct.stdout.includes("Item.php"), detailed);
      assert.equal(direct.stdout.includes(f.root), detailed);
      assert.deepEqual(
        value.checks.map((c: { id: string; status: string }) => [
          c.id,
          c.status,
        ]),
        (
          projectReport(library, detailed) as {
            checks: { id: string; status: string }[];
          }
        ).checks.map((c) => [c.id, c.status]),
      );
      const client = new Client(
        { name: "original-php-extensions", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [cli, "serve", ...args, "--allow-execution"],
            env,
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
        assert.equal(JSON.stringify(answer).includes(f.root), detailed);
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
    const denied = spawnSync(
      process.execPath,
      [cli, "run", "--root", f.root, ...grants],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(denied.status, 2);
    const client = new Client(
      { name: "original-php-extensions-no-trust", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "serve", "--root", f.root, ...grants],
          env,
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
  },
);
test(
  "php-extensions lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const mode of ["cancel", "timeout", "output"]) {
      const f = await phpOriginal(t, {
        fixed: true,
        checks: ["php.extensions"],
      });
      const worker =
        "posix_setsid();file_put_contents('child.ready',(string)getmypid());while(true){if(is_file('worker.release'))fwrite(STDOUT,str_repeat('original',4096));usleep(10000);}";
      const waiting =
        "<?php $child=proc_open([PHP_BINARY,'-r'," +
        JSON.stringify(worker) +
        "],[0=>['pipe','r'],1=>STDOUT,2=>STDERR],$pipes);while(!is_file('child.ready'))usleep(10000);file_put_contents('parent.pending',json_encode(['token'=>'" +
        mode +
        "','parent'=>getmypid(),'child'=>(int)file_get_contents('child.ready'),'temporary'=>getenv('CHECKTRAIL_TEMP')]));rename('parent.pending','parent.ready');while(true)usleep(10000);";
      await phpAtomic(path.join(f.root, "bootstrap/app.php"), waiting);
      const abort = new AbortController();
      const pending = validate(f.root, {
        ...f.options,
        timeoutMs: mode === "timeout" ? 4000 : 15000,
        signal: abort.signal,
      });
      void pending.catch(() => {});
      try {
        let ids:
          | { token: string; parent: number; child: number; temporary: string }
          | undefined;
        for (let n = 0; n < 400; n++) {
          try {
            ids = JSON.parse(
              await readFile(path.join(f.root, "parent.ready"), "utf8"),
            );
            break;
          } catch {
            await delay(10);
          }
        }
        assert.ok(ids, "Native bootstrap did not reach both waiting processes");
        assert.equal(ids.token, mode);
        assert.ok(ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child);
        process.kill(ids.parent, 0);
        process.kill(ids.child, 0);
        if (mode === "cancel") abort.abort();
        else if (mode === "output")
          await writeFile(path.join(f.root, "worker.release"), "release");
        const report = await pending;
        assert.equal(report.outcome, "incomplete");
        const execution = report.checks[0]!.processes[0]!;
        assert.equal(execution.cancelled, mode === "cancel");
        assert.equal(execution.timedOut, mode === "timeout");
        assert.equal(execution.truncated, mode === "output");
        assert.equal(execution.errorCode, undefined);
        assert.throws(() => process.kill(ids!.parent, 0));
        assert.throws(() => process.kill(ids!.child, 0));
        assert.ok(path.isAbsolute(ids.temporary));
        assert.match(path.basename(ids.temporary), /^checktrail-command-/);
        await assert.rejects(access(ids.temporary));
      } finally {
        abort.abort();
        await pending.catch(() => {});
      }
    }
  },
);
test(
  "php-extensions installed acceptance",
  { skip, timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_PHP_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "php-extensions",
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
    assert.equal(result.status, 0, result.stderr.slice(0, 3000));
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(receipt.offlineProductionInstall, true);
    assert.equal(receipt.profile.complete, true);
    assert.equal(receipt.profile.required, 9);
    assert.equal(receipt.profile.passed, 9);
  },
);
