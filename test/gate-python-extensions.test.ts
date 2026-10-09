import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { projectReport } from "../src/output.js";
import { runProcess } from "../src/runner.js";
import {
  pythonOriginal,
  pythonReceipt,
  pythonExtensionsSkip as skip,
  updatePythonDependency,
} from "./python-extensions-fixture.js";
type NativeReceipt = {
  manifest: { sourceFingerprint: string; toolPins: Array<{ sha256: string }> };
  inputsStable: boolean;
  complete: boolean;
  plugins: Array<{ loaded: boolean }>;
  environmentPackages: Array<{ version: string }>;
  dependencyParticipation: Array<{
    metadata: string;
    files: string[];
    complete: boolean;
  }>;
  modules: Array<{
    file: string;
    module: string;
    typeChecked: boolean;
    parsed: boolean;
    finished: boolean;
    suppressed: boolean;
  }>;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const replace = async (file: string, text: string) => {
  await writeFile(file + ".replacement", text);
  await rename(file + ".replacement", file);
};
test(
  "python-extensions broken acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks.map((c) => c.status),
      ["failed", "failed"],
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
    });
    const native = await pythonReceipt(root, report.checks[1]!);
    assert.match(
      native.native.stdout,
      /original plugin rejects reserved identifier/,
    );
    assert.equal(native.modules.length, 4);
    assert.equal(native.complete, true);
    assert.equal(report.sourceChanged, false);
  },
);
test(
  "python-extensions fixed acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t, { fixed: true });
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    for (const check of report.checks) {
      const native = await pythonReceipt(root, check);
      assert.equal(native.complete, true);
    }
    assert.equal(report.sourceChanged, false);
    assert.deepEqual(
      report.checks[1]!.tools?.map((tool) => [tool.name, tool.version]),
      [
        ["python", "3.12.13"],
        ["mypy", "2.3.1"],
      ],
    );
    await assert.rejects(access(path.join(root, "src/ns_policy/__pycache__")));
  },
);
test(
  "python-extensions near-miss acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t, { fixed: true });
    await replace(
      path.join(root, "src/ns_policy/consumer.py"),
      'from ns_policy.roles import register_role\nrole: str = register_role("grantTokenize")\n',
    );
    await mkdir(path.join(root, "outside"));
    await writeFile(
      path.join(root, "outside/not_selected.py"),
      "not valid python syntax !!!",
    );
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(
      report.checks.some((c) => c.scope.includes("outside/not_selected.py")),
      false,
    );
    const typed = await pythonReceipt(root, report.checks[1]!);
    assert.deepEqual(
      typed.modules.map((m: { module: string }) => m.module).sort(),
      [
        "ns_policy.consumer",
        "ns_policy.inputs",
        "ns_policy.roles",
        "test_roles",
      ],
    );
  },
);
test(
  "python-extensions prerequisite acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root, config } = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.mypy"],
    });
    const plugin = path.join(root, "plugins/type_rules.py");
    const original = await readFile(plugin, "utf8");
    await replace(
      plugin,
      "raise RuntimeError('must not be imported while planning')\n",
    );
    let plan = (await createPlan(root)).plan;
    assert.match(plan.checks[0]!.unavailableReason!, /plugin bytes changed/);
    await replace(plugin, original);
    const metadata = path.join(
      root,
      ".venv/lib/python3.12/site-packages/original_synthetic_dependency-1.0.0.dist-info/METADATA",
    );
    const originalMetadata = await readFile(metadata, "utf8");
    await replace(metadata, originalMetadata.replace("1.0.0", "2.0.0"));
    plan = (await createPlan(root)).plan;
    assert.match(
      plan.checks[0]!.unavailableReason!,
      /distribution is absent, ambiguous or incompatible/,
    );
    await replace(metadata, originalMetadata);
    await writeFile(
      path.join(
        root,
        ".venv/lib/python3.12/site-packages/original_synthetic_dependency/unrecorded.py",
      ),
      "value=1\n",
    );
    plan = (await createPlan(root)).plan;
    assert.match(
      plan.checks[0]!.unavailableReason!,
      /RECORD omits an actual file/,
    );
    const other = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.mypy"],
    });
    const base = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "from importlib.metadata import distribution;print(distribution('mypy').locate_file(''))",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(base.status, 0, base.stderr);
    const site = path.join(other.root, ".venv/lib/python3.12/site-packages");
    await cp(path.join(base.stdout.trim(), "mypy"), path.join(site, "mypy"), {
      recursive: true,
    });
    await cp(
      path.join(base.stdout.trim(), "mypy-2.3.1.dist-info"),
      path.join(site, "mypy-2.3.1.dist-info"),
      { recursive: true },
    );
    await writeFile(
      path.join(site, "mypy/main.py"),
      (await readFile(path.join(site, "mypy/main.py"), "utf8")) +
        "\n# original changed native API\n",
    );
    const markerSource =
      "from pathlib import Path\nPath('plugin-imported').write_text('unexpected')\n" +
      original;
    await replace(path.join(other.root, "plugins/type_rules.py"), markerSource);
    config.mypyPlugins[0]!.sha256 = hash(markerSource);
    await replace(
      path.join(other.root, "checktrail.python.json"),
      JSON.stringify(config),
    );
    const report = await validate(other.root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "unavailable",
      JSON.stringify(report.checks),
    );
    assert.match(report.checks[0]!.reason, /native API bytes changed/);
    await assert.rejects(access(path.join(other.root, "plugin-imported")));
  },
);
test(
  "python-extensions stale acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t, { fixed: true });
    const plan = (await createPlan(root)).plan;
    const passed = await validate(root, { trusted: true });
    for (const check of plan.checks) {
      const native = passed.checks.find((c) => c.id === check.id)!
        .processes[0]!;
      for (const modify of [
        (r: NativeReceipt) => {
          r.manifest.sourceFingerprint = "0".repeat(64);
        },
        (r: NativeReceipt) => {
          r.inputsStable = false;
        },
        (r: NativeReceipt) => {
          r.plugins[0]!.loaded = false;
        },
        (r: NativeReceipt) => {
          r.environmentPackages[0]!.version = "2.0.0";
        },
        (r: NativeReceipt) => {
          r.manifest.toolPins[0]!.sha256 = "0".repeat(64);
        },
      ]) {
        const receipt = JSON.parse(native.stdout);
        modify(receipt);
        assert.equal(
          evaluate(
            check,
            [{ ...native, stdout: JSON.stringify(receipt) }],
            root,
          ).status,
          "inconclusive",
        );
      }
    }
    for (const check of plan.checks) {
      const execution = passed.checks.find((c) => c.id === check.id)!
        .processes[0]!;
      assert.equal(
        evaluate({ ...check, id: "python.unittest" }, [execution], root).status,
        "inconclusive",
      );
      const receipt = JSON.parse(execution.stdout);
      receipt.manifest.toolPins[0].sha256 = "0".repeat(64);
      const args = [...check.commands[0]!.args];
      args[args.length - 1] = JSON.stringify(receipt.manifest);
      const changed = { ...check, commands: [{ ...check.commands[0]!, args }] };
      assert.equal(
        evaluate(
          changed,
          [{ ...execution, stdout: JSON.stringify(receipt) }],
          root,
        ).status,
        "inconclusive",
      );
    }
    const added = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.pytest"],
    });
    const old = (await createPlan(added.root)).plan.checks[0]!;
    await writeFile(
      path.join(
        added.root,
        ".venv/lib/python3.12/site-packages/original_synthetic_dependency/new_module.py",
      ),
      "value=1\n",
    );
    const changed = await runProcess(added.root, old.commands[0]!, {
      timeoutMs: 10000,
      maxOutputBytes: 65536,
    });
    assert.equal(changed.exitCode, 3, changed.stderr);
    assert.match(changed.stdout, /distribution tree inputs changed/);
    await updatePythonDependency(
      root,
      'def marker() -> str:\n    return "changed dependency"\n',
    );
    for (const check of plan.checks) {
      const execution = await runProcess(root, check.commands[0]!, {
        timeoutMs: 10000,
        maxOutputBytes: 65536,
      });
      assert.equal(execution.exitCode, 3, execution.stderr);
      assert.match(execution.stdout, /input bytes changed/);
      assert.equal(evaluate(check, [execution], root).status, "unavailable");
    }
  },
);
test(
  "python-extensions empty acceptance",
  { skip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.pytest"],
    });
    await replace(path.join(root, "tests/test_empty.py"), "");
    let report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "inconclusive",
      JSON.stringify(report.checks),
    );
    await replace(
      path.join(root, "tests/test_roles.py"),
      "import pytest\n@pytest.mark.skip\ndef test_skipped() -> None:\n    pass\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.checks[0]!.status, "inconclusive");
    assert.deepEqual(report.checks[0]!.tests, {
      total: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
    });
    const valid = await pythonOriginal(t, { fixed: true });
    const plan = (await createPlan(valid.root)).plan;
    const passed = await validate(valid.root, { trusted: true });
    for (const check of plan.checks) {
      const native = passed.checks.find((c) => c.id === check.id)!
        .processes[0]!;
      for (const stdout of ["", "{}", "null", native.stdout + native.stdout])
        assert.equal(
          evaluate(check, [{ ...native, stdout }], valid.root).status,
          "inconclusive",
        );
      assert.equal(evaluate(check, [], valid.root).status, "inconclusive");
    }
    const typed = plan.checks.find((c) => c.id === "python.mypy")!;
    const execution = passed.checks.find((c) => c.id === typed.id)!
      .processes[0]!;
    for (const change of [
      (r: NativeReceipt) => {
        r.complete = false;
      },
      (r: NativeReceipt) => {
        r.modules.pop();
      },
      (r: NativeReceipt) => {
        r.modules[1]!.file = r.modules[0]!.file;
      },
      (r: NativeReceipt) => {
        r.modules[1]!.module = r.modules[0]!.module;
      },
      (r: NativeReceipt) => {
        r.modules[0]!.typeChecked = false;
      },
      (r: NativeReceipt) => {
        r.modules[0]!.parsed = false;
      },
      (r: NativeReceipt) => {
        r.modules[0]!.finished = false;
      },
      (r: NativeReceipt) => {
        r.modules[0]!.suppressed = true;
      },
      (r: NativeReceipt) => {
        r.dependencyParticipation.pop();
      },
      (r: NativeReceipt) => {
        r.dependencyParticipation[0]!.complete = false;
      },
      (r: NativeReceipt) => {
        r.dependencyParticipation[0]!.files = [r.modules[0]!.file];
      },
    ]) {
      const r = JSON.parse(execution.stdout);
      change(r);
      assert.equal(
        evaluate(
          typed,
          [{ ...execution, stdout: JSON.stringify(r) }],
          valid.root,
        ).status,
        "inconclusive",
      );
    }
  },
);
test(
  "python-extensions privacy acceptance",
  { skip, timeout: 90000 },
  async (t) => {
    const { root } = await pythonOriginal(t, { fixed: true });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await assert.rejects(validate(root, { trusted: false }), /operator trust/);
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
      assert.equal(
        direct.stdout.includes("original plugin rejects reserved identifier"),
        false,
      );
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
        { name: "original-python-extensions", version: "1" },
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
      { name: "original-python-extensions-no-trust", version: "1" },
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
  },
);
test(
  "python-extensions lifecycle acceptance",
  { skip, timeout: 120000 },
  async (t) => {
    for (const kind of ["pytest", "mypy"] as const)
      for (const mode of ["cancel", "timeout", "output"]) {
        const { root, config } = await pythonOriginal(t, {
          fixed: true,
          checks: ["python." + kind],
        });
        const token = kind + mode;
        const worker =
          "import os,time,pathlib\npathlib.Path('child.ready').write_text(str(os.getpid()))\nwhile True:\n    if pathlib.Path('worker.release').exists():os.write(1,b'original'*4096)\n    time.sleep(0.01)\n";
        await writeFile(path.join(root, "child_worker.py"), worker);
        const waiting = `import os,sys,time,json,subprocess,pathlib\nchild=subprocess.Popen([sys.executable,'-I','-B','child_worker.py'],start_new_session=True)\nwhile not pathlib.Path('child.ready').exists():time.sleep(0.01)\npathlib.Path('parent.pending').write_text(json.dumps({'token':'${token}','parent':os.getpid(),'child':int(pathlib.Path('child.ready').read_text()),'temporary':os.environ['CHECKTRAIL_TEMP']}))\npathlib.Path('parent.pending').replace('parent.ready')\nwhile True:time.sleep(0.01)\n`;
        const file =
          kind === "pytest"
            ? "plugins/case_plugin.py"
            : "plugins/type_rules.py";
        await replace(path.join(root, file), waiting);
        (kind === "pytest"
          ? config.pytestPlugins[0]!
          : config.mypyPlugins[0]!
        ).sha256 = hash(waiting);
        await replace(
          path.join(root, "checktrail.python.json"),
          JSON.stringify(config),
        );
        const abort = new AbortController();
        const pending = validate(root, {
          trusted: true,
          timeoutMs: mode === "timeout" ? 4000 : 15000,
          signal: abort.signal,
        });
        void pending.catch(() => {});
        try {
          let ids:
            | {
                token: string;
                parent: number;
                child: number;
                temporary: string;
              }
            | undefined;
          for (let n = 0; n < 400; n++) {
            try {
              ids = JSON.parse(
                await readFile(path.join(root, "parent.ready"), "utf8"),
              );
              break;
            } catch {
              await delay(10);
            }
          }
          assert.ok(
            ids,
            "Native plugin never reached the original waiting parent",
          );
          assert.equal(ids.token, token);
          assert.ok(
            ids.parent > 1 && ids.child > 1 && ids.parent !== ids.child,
          );
          process.kill(ids.parent, 0);
          process.kill(ids.child, 0);
          if (mode === "cancel") abort.abort();
          else if (mode === "output")
            await writeFile(path.join(root, "worker.release"), "release");
          const report = await pending;
          assert.equal(report.outcome, "incomplete");
          const execution = report.checks[0]!.processes[0]!;
          assert.equal(execution.cancelled, mode === "cancel");
          assert.equal(execution.timedOut, mode === "timeout");
          assert.equal(execution.truncated, mode === "output");
          assert.equal(
            execution.errorCode,
            undefined,
            JSON.stringify(execution),
          );
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
  "python-extensions installed acceptance",
  { skip, timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_PYTHON_EXTENSIONS_INSTALLED === "1") {
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
      CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "python-extensions",
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
