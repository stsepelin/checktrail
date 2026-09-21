import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate, createPlan } from "../src/engine.js";
import { fixture } from "./helpers.js";

const packagePath = fileURLToPath(
  new URL(
    "../../.checktrail/php-tools/vendor/phpstan/phpstan",
    import.meta.url,
  ),
);
const prepared = await access(packagePath).then(
  () => true,
  () => false,
);
const available =
  prepared && spawnSync("php", ["--version"], { timeout: 10_000 }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["php.phpstan"] }],
});
const config = "parameters:\n    level: 5\n";
const good = "<?php\nfunction answer(): int { return 42; }\n";

test(
  "native PHPStan accounts for analysed files and catches return-type and configuration failures",
  {
    skip: available ? false : "PHP or prepared PHPStan unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, {
      "composer.json": "{}",
      "checktrail.json": policy,
      "phpstan.neon": config,
      "Example with spaces.php": good,
    });
    await cp(packagePath, path.join(root, "vendor/phpstan/phpstan"), {
      recursive: true,
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "phpstan")?.version,
      "2.2.14",
    );
    await replaceFixture(
      path.join(root, "Example with spaces.php"),
      good.replace("return 42", 'return "wrong"'),
    );
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.match(failed.checks[0]!.processes[0]!.stdout, /return.type/);
    assert.equal(failed.checks[0]!.findingsComplete, true);
    await replaceFixture(path.join(root, "Example with spaces.php"), good);
    await replaceFixture(
      path.join(root, "Omitted.php"),
      "<?php\nfunction another(): int { return 7; }\n",
    );
    await replaceFixture(
      path.join(root, "phpstan.neon"),
      config +
        "    excludePaths:\n        analyse:\n            - Omitted.php\n",
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(
      excluded.outcome,
      "incomplete",
      JSON.stringify(excluded.checks),
    );
    await replaceFixture(
      path.join(root, "Example with spaces.php"),
      good.replace("return 42", 'return "wrong"'),
    );
    const partial = await validate(root, { trusted: true });
    assert.equal(partial.outcome, "failed");
    assert.equal(partial.checks[0]!.findingsComplete, false);
    await replaceFixture(
      path.join(root, "phpstan.neon"),
      "parameters:\n    unknownSetting: true\n",
    );
    const invalid = await validate(root, { trusted: true });
    assert.notEqual(invalid.outcome, "passed");
    assert.equal(invalid.sourceChanged, false);
  },
);

test("PHPStan planning requires installed tools and config without executing PHP", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": policy,
    "phpstan.neon": config,
    "Example.php": good,
  });
  assert.equal((await createPlan(root)).plan.checks[0]!.id, "php.phpstan");
  const result = await validate(root, { trusted: true });
  assert.equal(result.checks[0]!.status, "unavailable");
  assert.equal(result.checks[0]!.processes.length, 0);
});

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}
