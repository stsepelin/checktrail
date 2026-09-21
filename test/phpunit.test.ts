import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const vendor = fileURLToPath(
  new URL("../../.repo-verifier/php-tools/vendor", import.meta.url),
);
const prepared = await access(
  path.join(vendor, "phpunit/phpunit/phpunit"),
).then(
  () => true,
  () => false,
);
const available =
  prepared && spawnSync("php", ["--version"], { timeout: 10_000 }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["php.phpunit"] }],
});
const good =
  "<?php\nuse PHPUnit\\Framework\\TestCase;\nfinal class ExampleTest extends TestCase { public function testAdds(): void { self::assertSame(5, 2 + 3); } }\n";

test(
  "native PHPUnit streams fresh evidence for assertions, failures, skips, empty and zero-assertion cases",
  {
    skip: available ? false : "PHP or prepared PHPUnit unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const root = await fixture(t, {
      "composer.json": "{}",
      "repo-verifier.json": policy,
      "ExampleTest.php": good,
    });
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.deepEqual(passed.checks[0]!.tests, {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "phpunit")?.version,
      "13.3.4",
    );
    for (const [source, outcome] of [
      [good.replace("assertSame(5", "assertSame(6"), "failed"],
      [
        good.replace(
          "self::assertSame(5, 2 + 3);",
          "self::markTestSkipped('synthetic');",
        ),
        "incomplete",
      ],
      [
        good.replace(
          "self::assertSame(5, 2 + 3);",
          "throw new RuntimeException('synthetic fixture failure');",
        ),
        "failed",
      ],
      ["<?php\n", "incomplete"],
    ]) {
      await replaceFixture(path.join(root, "ExampleTest.php"), source!);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, outcome, JSON.stringify(result.checks));
      assert.equal(result.sourceChanged, false);
    }
    await replaceFixture(
      path.join(root, "ExampleTest.php"),
      good.replace("self::assertSame(5, 2 + 3);", ""),
    );
    await replaceFixture(
      path.join(root, "phpunit.xml"),
      '<phpunit beStrictAboutTestsThatDoNotTestAnything="false"/>',
    );
    const assertionless = await validate(root, { trusted: true });
    assert.equal(assertionless.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(assertionless.outcome, "incomplete");
    await replaceFixture(path.join(root, "ExampleTest.php"), good);
    await replaceFixture(
      path.join(root, "OtherTest.php"),
      good.replaceAll("ExampleTest", "OtherTest"),
    );
    const multiple = await validate(root, { trusted: true });
    assert.equal(multiple.outcome, "passed", JSON.stringify(multiple.checks));
    assert.equal(multiple.checks[0]!.tests?.passed, 2);
    assert.equal(multiple.sourceChanged, false);
  },
);

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}
