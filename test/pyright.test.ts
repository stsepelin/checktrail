import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
const prepared =
  process.env.CHECKTRAIL_PYRIGHT_PACKAGE ??
  fileURLToPath(
    new URL("../../.checktrail/pyright-tools/package", import.meta.url),
  );
const available =
  spawnSync(process.execPath, [path.join(prepared, "index.js"), "--version"], {
    encoding: "utf8",
    timeout: 10_000,
  }).stdout?.trim() === "pyright 1.1.414";
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.pyright"] }],
});
const config = '[tool.pyright]\ntypeCheckingMode = "standard"\n';
async function install(root: string): Promise<void> {
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await cp(prepared, path.join(root, "node_modules/pyright"), {
    recursive: true,
  });
}
async function replace(
  root: string,
  file: string,
  text: string,
): Promise<void> {
  const target = path.join(root, file);
  const temporary = `${target}.replacement`;
  await writeFile(temporary, text, { flush: true });
  await rename(temporary, target);
}
async function nativeFixture(
  t: TestContext,
  extra: Record<string, string> = {},
): Promise<string> {
  const root = await fixture(t, {
    "pyproject.toml": config,
    "checktrail.json": policy,
    "value.py": "value: int = 42\n",
    ...extra,
  });
  await install(root);
  return root;
}
test("Pyright planning never executes configuration or installed tools and reports missing prerequisites", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": config,
    "checktrail.json": policy,
    "value.py": "value: int = 42\n",
    "node_modules/pyright/package.json": JSON.stringify({
      name: "pyright",
      version: "1.1.414",
    }),
    "node_modules/pyright/index.js":
      "require('node:fs').writeFileSync('executed','bad'); throw Error('executed');",
    "pyrightconfig.json": "This is intentionally malformed",
  });
  const result = (await createPlan(root)).plan;
  const check = result.checks.find((item) => item.id === "python.pyright")!;
  assert.deepEqual(check.scope, ["value.py"]);
  assert.equal(check.parser, "pyright-json");
  assert.equal(check.commands.length, 1);
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")));
  const missing = await fixture(t, {
    "pyproject.toml": config,
    "checktrail.json": policy,
    "value.py": "value: int = 42\n",
  });
  assert.match(
    (await createPlan(missing)).plan.checks[0]!.unavailableReason!,
    /not installed/,
  );
  const outside = await fixture(t, { "index.js": "throw Error('outside');" });
  await mkdir(path.join(missing, "node_modules"));
  await symlink(outside, path.join(missing, "node_modules/pyright"));
  assert.match(
    (await createPlan(missing)).plan.checks[0]!.unavailableReason!,
    /not installed/,
  );
  const empty = await fixture(t, {
    "pyproject.toml": config,
    "checktrail.json": policy,
  });
  assert.match(
    (await createPlan(empty)).plan.checks[0]!.unavailableReason!,
    /No Python source/,
  );
  const unusual = await fixture(t, {
    "pyproject.toml": config,
    "checktrail.json": policy,
    "value[1].py": "value: int = 42\n",
    "node_modules/pyright/index.js": "throw Error('unused');",
  });
  assert.match(
    (await createPlan(unusual)).plan.checks[0]!.unavailableReason!,
    /glob/,
  );
});
test(
  "native Pyright checks namespace source and stubs, catches broken and fixed types and preserves source",
  {
    skip: available ? false : "verified local Pyright unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await nativeFixture(t, {
      "value.py":
        "from namespace.value import number\nvalue: int = number\nnote = '# pyright: reportAssignmentType=false'\n",
      "namespace/value.py": "number: int = 42\n",
      "shapes.pyi": "number: int\n",
      "setup.py": "raise RuntimeError('must never execute setup.py')\n",
      ".cache/keep": "preserve",
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(passed.checks[0]!.findingsComplete, true);
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "pyright")?.version,
      "1.1.414",
    );
    assert.equal(
      await readFile(path.join(root, ".cache/keep"), "utf8"),
      "preserve",
    );
    await assert.rejects(access(path.join(root, "__pycache__")));
    await replace(root, "namespace/value.py", 'number: str = "bad"\n');
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(broken.checks[0]!.findingsComplete, true);
    assert.deepEqual(
      broken.checks[0]!.findings?.map(({ file, line, ruleId }) => ({
        file,
        line,
        ruleId,
      })),
      [{ file: "value.py", line: 2, ruleId: "reportAssignmentType" }],
    );
    await replace(root, "namespace/value.py", "number: int = 42\n");
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(root, "value.py", "value: int =\n");
    const syntax = await validate(root, { trusted: true });
    assert.equal(syntax.outcome, "failed", JSON.stringify(syntax.checks));
  },
);
test(
  "native Pyright refuses clean completion for excluded sources and configuration or comment suppression",
  {
    skip: available ? false : "verified local Pyright unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await nativeFixture(t, { "value.py": 'value: int = "bad"\n' });
    for (const settings of [
      { typeCheckingMode: "off" },
      { ignore: ["value.py"] },
      { reportAssignmentType: "none" },
      { executionEnvironments: [{ root: ".", reportAssignmentType: false }] },
    ]) {
      await replace(root, "pyproject.toml", "");
      await writeFile(
        path.join(root, "pyrightconfig.json"),
        JSON.stringify(settings),
      );
      const result = await validate(root, { trusted: true });
      assert.notEqual(result.outcome, "passed", JSON.stringify(settings));
      if (result.checks[0]!.status === "failed")
        assert.equal(result.checks[0]!.findingsComplete, false);
    }
    await replace(
      root,
      "pyrightconfig.json",
      JSON.stringify({ exclude: ["value.py"] }),
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await replace(
      root,
      "pyrightconfig.json",
      JSON.stringify({ typeCheckingMode: "standard" }),
    );
    for (const source of [
      '# pyright: reportAssignmentType=false\nvalue: int = "bad"\n',
      'value: int = "bad" # pyright: ignore[reportAssignmentType]\n',
      'value: int = "bad" # type: ignore\n',
      'value: int = "bad" # explanation # pyright: ignore[reportAssignmentType]\n',
      'value: int = "bad" # explanation # type: ignore\n',
    ]) {
      await replace(root, "value.py", source);
      assert.equal(
        (await validate(root, { trusted: true })).outcome,
        "incomplete",
        source,
      );
    }
    await replace(root, "value.py", "# pyright: strict\nvalue: int = 42\n");
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      root,
      "pyrightconfig.json",
      JSON.stringify({ extends: "base.toml" }),
    );
    await writeFile(
      path.join(root, "base.toml"),
      '[tool.pyright]\nignore = ["value.py"]\n',
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
  },
);
test(
  "native Pyright accounts for versions, invalid configuration and environment-specific import errors",
  {
    skip: available ? false : "verified local Pyright unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await nativeFixture(t);
    await replace(
      root,
      "pyproject.toml",
      '[tool.pyright]\npythonVersion="3.12"\nexecutionEnvironments=[{root=".",extraPaths=["lib"]}]\n',
    );
    await mkdir(path.join(root, "lib"));
    await writeFile(path.join(root, "lib/values.py"), "number: int\n");
    await replace(
      root,
      "value.py",
      "from values import number\nvalue: int = number\n",
    );
    const configured = await validate(root, { trusted: true });
    assert.equal(
      configured.outcome,
      "passed",
      JSON.stringify(configured.checks),
    );
    await replace(
      root,
      "value.py",
      "from missing_original_synthetic_module import value\n",
    );
    const missing = await validate(root, { trusted: true });
    assert.equal(missing.outcome, "failed");
    assert.equal(missing.sourceChanged, false);
    assert.ok(
      missing.checks[0]!.findings?.some(
        (finding) => finding.ruleId === "reportMissingImports",
      ),
    );
    await replace(root, "pyproject.toml", "[tool.pyright\n");
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "error",
    );
    await writeFile(
      path.join(root, "pyrightconfig.json"),
      JSON.stringify({ extends: "pyrightconfig.json" }),
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "error",
    );
    await replace(
      root,
      "pyrightconfig.json",
      JSON.stringify({ extends: "../../../outside.json" }),
    );
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "error",
    );
    const metadata = path.join(root, "node_modules/pyright/package.json");
    const data = JSON.parse(await readFile(metadata, "utf8")) as Record<
      string,
      unknown
    >;
    data.version = "0.0.0";
    await writeFile(metadata, JSON.stringify(data));
    assert.equal(
      (await validate(root, { trusted: true })).checks[0]!.status,
      "unavailable",
    );
  },
);

test(
  "native Pyright resolves a configured synthetic virtual environment without executing package source",
  {
    skip: available ? false : "verified local Pyright unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await nativeFixture(t, {
      "pyproject.toml":
        '[tool.pyright]\npythonVersion="3.12"\nvenvPath="."\nvenv=".venv"\n',
      "value.py":
        "from original_synthetic_library import number\nvalue: int = number\n",
      ".venv/pyvenv.cfg":
        "include-system-site-packages = false\nversion = 3.12.0\n",
      ".venv/lib/python3.12/site-packages/original_synthetic_library/py.typed":
        "",
      ".venv/lib/python3.12/site-packages/original_synthetic_library/__init__.py":
        "from pathlib import Path\nPath('package-executed').write_text('unexpected')\nnumber: int = 42\n",
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    await assert.rejects(access(path.join(root, "package-executed")));
    await replace(
      root,
      "value.py",
      "from original_synthetic_library import number\nvalue: str = number\n",
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.ok(
      broken.checks[0]!.findings?.some(
        (finding) => finding.ruleId === "reportAssignmentType",
      ),
    );
    await replace(
      root,
      "pyproject.toml",
      '[tool.pyright]\npythonVersion="3.12"\nvenvPath="."\nvenv="missing_synthetic_environment"\n',
    );
    const absent = await validate(root, { trusted: true });
    assert.notEqual(absent.outcome, "passed");
  },
);
test(
  "native Pyright shares source accounting and findings across CLI and MCP",
  {
    skip: available ? false : "verified local Pyright unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await nativeFixture(t, { "value.py": 'value: int = "bad"\n' });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project", "--detailed"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout) as {
      outcome: string;
      checks: { findings: unknown; scope: string[] }[];
    };
    assert.equal(report.outcome, "failed");
    assert.deepEqual(
      (
        report.checks[0]!.findings as {
          file: string;
          line: number;
          ruleId: string;
        }[]
      ).map(({ file, line, ruleId }) => ({ file, line, ruleId })),
      [{ file: "value.py", line: 1, ruleId: "reportAssignmentType" }],
    );
    const client = new Client(
      {
        name: "checktrail-pyright-native-test",
        version: "1.0.0",
      },
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
            "--detailed",
          ],
        }),
      );
      const native = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(native.isError, undefined);
      const retained = native.structuredContent as {
        outcome: string;
        checks: { findings: unknown; scope: string[] }[];
      };
      assert.equal(retained.outcome, "failed");
      assert.deepEqual(
        retained.checks.map(({ scope, findings }) => ({ scope, findings })),
        report.checks.map(({ scope, findings }) => ({ scope, findings })),
      );
    } finally {
      await client.close();
    }
  },
);
