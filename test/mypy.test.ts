import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.mypy"] }],
});
const available =
  spawnSync(
    "python3",
    [
      "-c",
      "from mypy.version import __version__; assert __version__ == '2.3.1'",
    ],
    { timeout: 10_000 },
  ).status === 0;
const config = "[tool.mypy]\ninstall_types = true\n";

test(
  "native mypy checks explicit files and rejects broad suppression without writing caches or installing stubs",
  { skip: available ? false : "verified mypy unavailable", timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      "pyproject.toml": config,
      "checktrail.json": policy,
      "value.py": "value: int = 42\n",
      ".mypy_cache/keep": "preserve",
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, ".mypy_cache/keep"), "utf8"),
      "preserve",
    );
    await assert.rejects(access(path.join(root, "__pycache__")));
    await replaceFixture(path.join(root, "value.py"), 'value: int = "bad"\n');
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.match(failed.checks[0]!.processes[0]!.stdout, /Incompatible types/);
    await replaceFixture(
      path.join(root, "pyproject.toml"),
      "[tool.mypy]\nignore_errors = true\n",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await replaceFixture(
      path.join(root, "pyproject.toml"),
      '[tool.mypy]\n[[tool.mypy.overrides]]\nmodule = "value"\nignore_errors = true\n',
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await replaceFixture(path.join(root, "pyproject.toml"), config);
    await replaceFixture(path.join(root, "value.py"), "import requests\n");
    const missing = await validate(root, { trusted: true });
    assert.equal(missing.outcome, "failed", JSON.stringify(missing.checks));
    assert.equal(missing.sourceChanged, false);
    assert.match(missing.checks[0]!.processes[0]!.stdout, /types-requests/);
    assert.doesNotMatch(
      missing.checks[0]!.processes[0]!.stdout,
      /Installing missing stub packages/,
    );
    await replaceFixture(
      path.join(root, "value.py"),
      "value: int = 42  # type: ignore\n",
    );
    const stale = await validate(root, { trusted: true });
    assert.equal(stale.outcome, "failed", JSON.stringify(stale.checks));
    assert.match(stale.checks[0]!.processes[0]!.stdout, /Unused.*ignore/);
  },
);

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}
