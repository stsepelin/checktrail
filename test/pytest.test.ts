import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.pytest"] }],
});
const good = "def test_adds():\n    assert 2 + 3 == 5\n";
const available =
  spawnSync("python3", ["-c", "import pytest"], { timeout: 10_000 }).status ===
  0;

test(
  "native pytest accounts for assertion and fixture lifecycle, empty files and deselection",
  { skip: available ? false : "pytest unavailable", timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      "pyproject.toml":
        '[tool.pytest.ini_options]\naddopts = "--collect-only -k nonexistent"\n',
      "checktrail.json": policy,
      "test_sum.py": good,
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    await assert.rejects(access(path.join(root, ".pytest_cache")));
    await assert.rejects(access(path.join(root, "__pycache__")));
    for (const [source, outcome] of [
      [good.replace("== 5", "== 6"), "failed"],
      [
        "import pytest\n@pytest.mark.skip\ndef test_skip():\n    pass\n",
        "incomplete",
      ],
      [
        "import pytest\n@pytest.mark.xfail\ndef test_xfail():\n    assert False\n",
        "incomplete",
      ],
      [
        "import pytest\n@pytest.mark.xfail(strict=False)\ndef test_xpass():\n    assert True\n",
        "failed",
      ],
      [
        "import pytest\n@pytest.fixture\ndef broken():\n    raise RuntimeError('setup failed')\ndef test_setup(broken):\n    pass\n",
        "failed",
      ],
      [
        "import pytest\n@pytest.fixture\ndef broken():\n    yield 1\n    raise RuntimeError('teardown failed')\ndef test_teardown(broken):\n    assert broken == 1\n",
        "failed",
      ],
      ["raise RuntimeError('import failed')\n", "failed"],
      ["", "incomplete"],
    ]) {
      await replaceFixture(path.join(root, "test_sum.py"), source!);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, outcome, JSON.stringify(result.checks));
      assert.equal(result.sourceChanged, false);
    }
    await replaceFixture(path.join(root, "test_sum.py"), good);
    await replaceFixture(path.join(root, "test_empty.py"), "");
    const empty = await validate(root, { trusted: true });
    assert.equal(empty.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(empty.outcome, "incomplete");
    await replaceFixture(path.join(root, "test_empty.py"), good);
    await replaceFixture(
      path.join(root, "conftest.py"),
      "def pytest_collection_modifyitems(config, items):\n    omitted = items.pop()\n    config.hook.pytest_deselected(items=[omitted])\n",
    );
    const deselected = await validate(root, { trusted: true });
    assert.equal(deselected.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(deselected.outcome, "incomplete");
  },
);

test("pytest planning does not import project conftest", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": "",
    "checktrail.json": policy,
    "test_sum.py": good,
    "conftest.py": "raise RuntimeError('configuration ran')",
  });
  assert.equal((await createPlan(root)).plan.checks[0]!.id, "python.pytest");
});

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}
