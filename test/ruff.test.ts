import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.ruff"] }],
});
const config =
  '[tool.ruff]\nfix = true\nfix-only = true\n[tool.ruff.lint]\nselect = ["F"]\n';
const available =
  spawnSync("ruff", ["--version"], { timeout: 10_000 }).status === 0;

test(
  "native Ruff accounts for selected files and active rules and never fixes source",
  { skip: available ? false : "Ruff unavailable", timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      "pyproject.toml": config,
      "repo-verifier.json": policy,
      "value with spaces.py": "value = 42\n",
      ".ruff_cache/keep": "preserve",
    });
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, ".ruff_cache/keep"), "utf8"),
      "preserve",
    );
    for (const [source, line] of [
      ["import os\n", 1],
      ["value = missing_name\n", 1],
      ["value = (\n", 2],
    ] as const) {
      await replaceFixture(path.join(root, "value with spaces.py"), source);
      const failed = await validate(root, { trusted: true });
      assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
      assert.equal(failed.sourceChanged, false);
      assert.equal(
        failed.checks[0]!.findingsComplete,
        source !== "value = (\n",
      );
      assert.equal(
        failed.checks[0]!.findings?.[0]?.file,
        "value with spaces.py",
      );
      assert.equal(failed.checks[0]!.findings?.[0]?.line, line);
      assert.ok(failed.checks[0]!.findings?.[0]?.ruleId);
      assert.equal(
        await readFile(path.join(root, "value with spaces.py"), "utf8"),
        source,
      );
    }
    await replaceFixture(
      path.join(root, "value with spaces.py"),
      "value = 42\n",
    );
    for (const policyConfig of [
      '[tool.ruff]\nexclude = ["value with spaces.py"]\n[tool.ruff.lint]\nselect = ["F"]\n',
      "[tool.ruff.lint]\nselect = []\n",
      '[tool.ruff.lint]\nselect = ["F"]\nper-file-ignores = {"value with spaces.py" = ["ALL"]}\n',
    ]) {
      await replaceFixture(path.join(root, "pyproject.toml"), policyConfig);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, "incomplete", JSON.stringify(result.checks));
    }
  },
);

test("Ruff planning describes explicit source and stub files without running tools", async (t) => {
  const root = await fixture(t, {
    "pyproject.toml": config,
    "repo-verifier.json": policy,
    "value.py": "value = 42",
    "value.pyi": "value: int",
  });
  assert.deepEqual((await createPlan(root)).plan.checks[0]!.scope, [
    "value.py",
    "value.pyi",
  ]);
});

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}
