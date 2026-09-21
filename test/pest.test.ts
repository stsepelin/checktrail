import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const vendor = fileURLToPath(
  new URL("../../.checktrail/php-tools/vendor", import.meta.url),
);
const prepared = await access(path.join(vendor, "pest-plugins.json")).then(
  () => true,
  () => false,
);
const available =
  prepared && spawnSync("php", ["--version"], { timeout: 10_000 }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["php.pest"] }],
});
const good = "<?php\ntest('adds', fn () => expect(2 + 3)->toBe(5));\n";

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}

test("Pest planning requires configuration without executing PHP", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": policy,
    "tests/ExampleTest.php": good,
    "vendor/pestphp/pest/bin/pest":
      "<?php throw new Exception('planning executed code');",
  });
  const missing = await createPlan(root);
  assert.match(missing.plan.checks[0]!.unavailableReason!, /local phpunit.xml/);
  await writeFile(path.join(root, "phpunit.xml"), "<phpunit/>");
  const ready = await createPlan(root);
  assert.equal(ready.plan.checks[0]!.unavailableReason, undefined);
  assert.ok(ready.plan.checks[0]!.commands[0]!.args.includes("--no-tia"));
  await writeFile(path.join(root, "tests/ambiguous::Test.php"), good);
  const ambiguous = await createPlan(root);
  assert.match(ambiguous.plan.checks[0]!.unavailableReason!, /containing ::/);
});

test(
  "native Pest runs focused siblings, datasets and fresh snapshots without replaying cached tests",
  {
    skip: available ? false : "PHP or prepared Pest unavailable",
    timeout: 120_000,
  },
  async (t) => {
    const root = await fixture(t, {
      "composer.json": "{}",
      "checktrail.json": policy,
      "phpunit.xml":
        '<phpunit beStrictAboutTestsThatDoNotTestAnything="false"/>',
      "tests/ExampleTest.php": good,
      "tests/Pest.php": "<?php\npest()->tia()->always();\n",
    });
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    await mkdir(
      path.join(
        root,
        "vendor/pestphp/pest-plugin-mutate/.temp/pest-mutate-cache",
      ),
      { recursive: true },
    );
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "pest")?.version,
      "5.2.1",
    );
    assert.equal(passed.sourceChanged, false);
    const cases = [
      [good.replace("toBe(5)", "toBe(6)"), "failed"],
      [
        "<?php\ntest('focused', fn () => expect(true)->toBeTrue())->only();\ntest('hidden failure', fn () => expect(false)->toBeTrue());\n",
        "failed",
      ],
      [
        "<?php\ntest('dataset', fn ($value) => expect($value)->toBeGreaterThan(0))->with([1, 2]);\n",
        "passed",
      ],
      [
        "<?php\ntest('dataset', fn ($value) => expect($value)->toBeGreaterThan(0))->with([1, -2]);\n",
        "failed",
      ],
      [good.replace("->toBe(5));", "->toBe(5))->skip();"), "incomplete"],
      ["<?php\ntest('later')->todo();\n", "incomplete"],
      ["<?php\n", "incomplete"],
      ["<?php\ntest('no assertions', function () {});\n", "incomplete"],
      [
        "<?php\nbeforeEach(function () { throw new RuntimeException('synthetic fixture failure'); });\n" +
          good.slice(6),
        "failed",
      ],
      [
        "<?php\ntest('snapshot', fn () => expect('synthetic')->toMatchSnapshot());\n",
        "failed",
      ],
    ] as const;
    for (const [source, outcome] of cases) {
      await replaceFixture(path.join(root, "tests/ExampleTest.php"), source);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, outcome, JSON.stringify(result.checks));
      assert.equal(result.sourceChanged, false);
      if (source.includes("[1, 2]"))
        assert.equal(result.checks[0]!.tests?.passed, 2);
      if (source.includes("hidden failure"))
        assert.equal(result.checks[0]!.tests?.failed, 1);
    }
    assert.equal(
      await access(path.join(root, "tests/__snapshots__")).then(
        () => true,
        () => false,
      ),
      false,
    );
    await replaceFixture(path.join(root, "tests/ExampleTest.php"), good);
    await replaceFixture(
      path.join(root, "tests/OtherTest.php"),
      good.replace("adds", "also adds"),
    );
    const multiple = await validate(root, { trusted: true });
    assert.equal(multiple.outcome, "passed", JSON.stringify(multiple.checks));
    assert.equal(multiple.checks[0]!.tests?.passed, 2);
    const original = await readFile(
      path.join(root, "vendor/pest-plugins.json"),
      "utf8",
    );
    await rm(path.join(root, "vendor/pest-plugins.json"));
    const missingPlugins = await validate(root, { trusted: true });
    assert.equal(missingPlugins.outcome, "incomplete");
    await writeFile(path.join(root, "vendor/pest-plugins.json"), original);
  },
);
