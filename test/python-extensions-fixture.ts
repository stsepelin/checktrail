import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture } from "./helpers.js";
export const pythonExtensionsAvailable =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      "import sys;from importlib.metadata import version;assert sys.version_info[:3]==(3,12,13);assert version('mypy')=='2.3.1';assert version('pytest')=='9.1.1'",
    ],
    { timeout: 10000 },
  ).status === 0;
export const pythonExtensionsSkip = pythonExtensionsAvailable
  ? false
  : "selected Linux ARM64 Python extension runtime unavailable";
export const pythonBroken =
  'def permitted(value: str) -> bool:\n    return value.startswith("grant")\n\ndef register_role(value: str) -> str:\n    return value\n';
export const pythonFixed = pythonBroken.replace(
  'value.startswith("grant")',
  'value == "grant" or value.startswith("grant:")',
);
export const pytestPlugin =
  "import pytest\nfrom ns_policy.inputs import cases\n\n@pytest.fixture(params=cases)\ndef key_case(request):\n    return request.param\n";
export const mypyPlugin =
  'from mypy.plugin import Plugin\nfrom mypy.nodes import StrExpr\n\ndef check_role(ctx):\n    if ctx.args and ctx.args[0] and isinstance(ctx.args[0][0], StrExpr) and ctx.args[0][0].value == "grantToken":\n        ctx.api.fail("original plugin rejects reserved identifier", ctx.context)\n    return ctx.default_return_type\n\nclass Rules(Plugin):\n    def get_function_hook(self, fullname):\n        return check_role if fullname == "ns_policy.roles.register_role" else None\n\ndef plugin(version):\n    return Rules\n';
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function updatePythonDependency(
  root: string,
  source = 'def marker() -> str:\n    return "public"\n',
) {
  const site = path.join(root, ".venv/lib/python3.12/site-packages");
  const files = {
    "original_synthetic_dependency/__init__.py": source,
    "original_synthetic_dependency/py.typed": "",
    "original_synthetic_dependency-1.0.0.dist-info/METADATA":
      "Metadata-Version: 2.1\nName: original-synthetic-dependency\nVersion: 1.0.0\n",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(site, file)), { recursive: true });
    await writeFile(path.join(site, file), content);
  }
  const record =
    Object.entries(files)
      .map(
        ([file, content]) =>
          `${file},sha256=${createHash("sha256").update(content).digest("base64url")},${Buffer.byteLength(content)}`,
      )
      .join("\n") +
    "\noriginal_synthetic_dependency-1.0.0.dist-info/RECORD,,\n";
  await writeFile(
    path.join(site, "original_synthetic_dependency-1.0.0.dist-info/RECORD"),
    record,
  );
}
export async function pythonOriginal(
  t: TestContext,
  options: { fixed?: boolean; checks?: string[] } = {},
) {
  const config = {
    schemaVersion: 1,
    moduleRoots: ["src", "src_extra", "tests"],
    environment: {
      directory: ".venv",
      dependencies: [
        { name: "original-synthetic-dependency", version: "1.0.0" },
      ],
    },
    pytestPlugins: [
      {
        module: "case_plugin",
        path: "plugins/case_plugin.py",
        sha256: hash(pytestPlugin),
      },
    ],
    mypyPlugins: [{ path: "plugins/type_rules.py", sha256: hash(mypyPlugin) }],
  };
  const root = await realpath(
    await fixture(t, {
      "pyproject.toml": '[tool.mypy]\nplugins = ["plugins/type_rules.py"]\n',
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: options.checks ?? ["python.pytest", "python.mypy"],
          },
        ],
      }),
      "checktrail.python.json": JSON.stringify(config),
      "src/ns_policy/roles.py": options.fixed ? pythonFixed : pythonBroken,
      "src/ns_policy/consumer.py": `from ns_policy.roles import register_role\nrole: str = register_role("${options.fixed ? "grant:read" : "grantToken"}")\n`,
      "src_extra/ns_policy/inputs.py":
        'cases: list[tuple[str, bool]] = [("grant:read", True), ("grantToken", False), ("grant2", False)]\n',
      "tests/test_roles.py":
        'from ns_policy.roles import permitted\nfrom original_synthetic_dependency import marker\n\ndef test_identifier(key_case: tuple[str, bool]) -> None:\n    value, expected = key_case\n    assert permitted(value) is expected\n\ndef test_environment() -> None:\n    result: str = marker()\n    assert result == "public"\n',
      "plugins/case_plugin.py": pytestPlugin,
      "plugins/type_rules.py": mypyPlugin,
      ".mypy_cache/keep": "original cache",
      ".pytest_cache/keep": "original cache",
    }),
  );
  const native = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-m",
      "venv",
      "--without-pip",
      "--system-site-packages",
      "--copies",
      path.join(root, ".venv"),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.signal, null);
  await updatePythonDependency(root);
  return { root, config };
}
export async function pythonReceipt(
  root: string,
  check: { processes: Array<{ stdout: string }> },
) {
  const value = JSON.parse(check.processes[0]!.stdout);
  assert.equal(value.inputsStable, true);
  assert.equal(value.plugins.length, 1);
  assert.equal(value.plugins[0].loaded, true);
  assert.equal(
    value.environmentPackages[0].name,
    "original-synthetic-dependency",
  );
  assert.equal(
    await readFile(path.join(root, ".mypy_cache/keep"), "utf8"),
    "original cache",
  );
  assert.equal(
    await readFile(path.join(root, ".pytest_cache/keep"), "utf8"),
    "original cache",
  );
  return value;
}
