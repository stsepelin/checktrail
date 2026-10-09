import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { mypyEvidence } from "../src/mypy-evidence.js";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import {
  pythonOriginal,
  pythonReceipt,
  pythonExtensionsSkip,
  updatePythonDependency,
} from "./python-extensions-fixture.js";
test(
  "native Python extensions reach both namespace roots virtualenv distribution and project-enabled pytest mypy plugins",
  { skip: pythonExtensionsSkip, timeout: 90000 },
  async (t) => {
    const { root } = await pythonOriginal(t);
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks.length, 2);
    assert.equal(
      broken.checks[0]!.status,
      "failed",
      JSON.stringify(broken.checks),
    );
    assert.deepEqual(broken.checks[0]!.tests, {
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
    });
    assert.equal(
      broken.checks[1]!.status,
      "failed",
      JSON.stringify(broken.checks),
    );
    const typed = await pythonReceipt(root, broken.checks[1]!);
    assert.match(
      typed.native.stdout,
      /original plugin rejects reserved identifier/,
    );
    const repaired = await pythonOriginal(t, { fixed: true });
    const passed = await validate(repaired.root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    for (const check of passed.checks)
      await pythonReceipt(repaired.root, check);
    const receipt = await pythonReceipt(repaired.root, passed.checks[1]!);
    assert.deepEqual(
      receipt.modules.map((m: { module: string }) => m.module).sort(),
      [
        "ns_policy.consumer",
        "ns_policy.inputs",
        "ns_policy.roles",
        "test_roles",
      ],
    );
    assert.equal(receipt.complete, true);
    assert.equal(passed.sourceChanged, false);
    const plan = await createPlan(repaired.root);
    assert.equal(plan.plan.checks.length, 2);
  },
);

test(
  "native Python extension source participation rejects semantic-only mypy success",
  { skip: pythonExtensionsSkip, timeout: 60000 },
  async (t) => {
    const { root, config } = await pythonOriginal(t, {
      checks: ["python.mypy"],
    });
    const file = path.join(root, "plugins/type_rules.py");
    const original = await readFile(file, "utf8");
    const changed = original.replace(
      "class Rules(Plugin):\n",
      "class Rules(Plugin):\n    def __init__(self, options):\n        super().__init__(options)\n        options.semantic_analysis_only = True\n",
    );
    assert.notEqual(changed, original);
    await writeFile(file, changed);
    config.mypyPlugins[0]!.sha256 = createHash("sha256")
      .update(changed)
      .digest("hex");
    await writeFile(
      path.join(root, "checktrail.python.json"),
      JSON.stringify(config),
    );
    const planned = (await createPlan(root)).plan.checks[0]!;
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "inconclusive",
      JSON.stringify(report.checks),
    );
    const execution = report.checks[0]!.processes[0]!;
    const receipt = JSON.parse(execution.stdout);
    assert.equal(receipt.native.exitCode, 0);
    assert.match(
      receipt.native.stdout,
      /Success: no issues found in 4 source files/,
    );
    assert.equal(receipt.complete, false);
    assert.equal(
      receipt.modules.every((m: { typeChecked: boolean }) => !m.typeChecked),
      true,
    );
    assert.equal(
      mypyEvidence(
        { ...planned, parser: "mypy-json" },
        [{ ...execution, stdout: JSON.stringify(receipt.native) }],
        root,
      ).status,
      "passed",
    );
  },
);
test(
  "native Python extension rechecks excluded virtualenv bytes after successful pytest",
  { skip: pythonExtensionsSkip, timeout: 60000 },
  async (t) => {
    const { root, config } = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.pytest"],
    });
    const file = path.join(root, "plugins/case_plugin.py");
    const changed =
      (await readFile(file, "utf8")) +
      "\ndef pytest_sessionfinish(session, exitstatus):\n    import pathlib,sys\n    target=pathlib.Path(sys.prefix)/'lib/python3.12/site-packages/original_synthetic_dependency/__init__.py'\n    target.write_text('def marker() -> str:\\n    return \\\"changed after successful tests\\\"\\n')\n";
    await writeFile(file, changed);
    config.pytestPlugins[0]!.sha256 = createHash("sha256")
      .update(changed)
      .digest("hex");
    await writeFile(
      path.join(root, "checktrail.python.json"),
      JSON.stringify(config),
    );
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "inconclusive",
      JSON.stringify(report.checks),
    );
    assert.equal(report.sourceChanged, false);
    const receipt = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(receipt.native.exitCode, 0);
    assert.equal(receipt.native.finished, true);
    assert.equal(receipt.inputsStable, false);
    assert.match(report.checks[0]!.processes[0]!.stderr, /input bytes changed/);
  },
);

test(
  "native Python extension dependency origins cannot borrow declared virtualenv metadata",
  { skip: pythonExtensionsSkip, timeout: 60000 },
  async (t) => {
    const { root, config } = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.pytest"],
    });
    const alternate = path.join(
      root,
      "alternate/original_synthetic_dependency",
    );
    await mkdir(alternate, { recursive: true });
    await writeFile(
      path.join(alternate, "__init__.py"),
      'def marker() -> str:\n    return "public"\n',
    );
    const file = path.join(root, "plugins/case_plugin.py");
    const changed =
      (await readFile(file, "utf8")) +
      "\nimport sys,pathlib\nsys.path.insert(0,str(pathlib.Path(__file__).parent.parent/'alternate'))\n";
    await writeFile(file, changed);
    config.pytestPlugins[0]!.sha256 = createHash("sha256")
      .update(changed)
      .digest("hex");
    await writeFile(
      path.join(root, "checktrail.python.json"),
      JSON.stringify(config),
    );
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "inconclusive",
      JSON.stringify(report.checks),
    );
    const receipt = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    assert.equal(receipt.native.exitCode, 0);
    assert.equal(receipt.inputsStable, true);
    assert.equal(receipt.dependencyParticipation[0].complete, false);
    assert.equal(
      receipt.native.reports.filter(
        (r: { phase: string; outcome: string }) =>
          r.phase === "call" && r.outcome === "passed",
      ).length,
      4,
    );
    assert.deepEqual(receipt.dependencyParticipation[0].files, [
      path.join(alternate, "__init__.py"),
    ]);
  },
);

test(
  "native Python extension ignores stale timestamp bytecode and preserves existing caches",
  { skip: pythonExtensionsSkip, timeout: 60000 },
  async (t) => {
    const { root } = await pythonOriginal(t, {
      fixed: true,
      checks: ["python.pytest"],
    });
    const source = path.join(
      root,
      ".venv/lib/python3.12/site-packages/original_synthetic_dependency/__init__.py",
    );
    const binary = path.join(root, ".venv/bin/python3");
    const before = await stat(source);
    const compiled = spawnSync(
      binary,
      [
        "-I",
        "-B",
        "-c",
        "import py_compile,sys,importlib.util;py_compile.compile(sys.argv[1],doraise=True);print(importlib.util.cache_from_source(sys.argv[1]))",
        source,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const cache = compiled.stdout.trim();
    const cachedBytes = await readFile(cache);
    await updatePythonDependency(
      root,
      'def marker() -> str:\n    return "broken"\n',
    );
    assert.equal((await stat(source)).size, before.size);
    const restored = spawnSync(
      binary,
      [
        "-I",
        "-B",
        "-c",
        "import os,sys;os.utime(sys.argv[1],ns=(int(sys.argv[2]),int(sys.argv[3])))",
        source,
        String(Math.trunc(before.atimeMs * 1000000)),
        String(Math.trunc(before.mtimeMs * 1000000)),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(restored.status, 0, restored.stderr);
    const stale = spawnSync(
      binary,
      [
        "-I",
        "-B",
        "-c",
        "from original_synthetic_dependency import marker;print(marker())",
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(stale.stdout.trim(), "public");
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.checks[0]!.status,
      "failed",
      JSON.stringify(report.checks),
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 3,
      failed: 1,
      skipped: 0,
    });
    assert.deepEqual(await readFile(cache), cachedBytes);
    assert.equal(report.sourceChanged, false);
  },
);
