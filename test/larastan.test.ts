import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { createPlan, validate } from "../src/engine.js";
const vendor = fileURLToPath(
  new URL("../../.checktrail/php-review-tools/vendor", import.meta.url),
);
const available = await access(
  path.join(vendor, "larastan/larastan/extension.neon"),
).then(
  () => spawnSync("php", ["--version"], { timeout: 10000 }).status === 0,
  () => false,
);
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [
    {
      path: ".",
      checks: ["php.phpstan"],
      environment: [
        "APP_PACKAGES_CACHE",
        "APP_SERVICES_CACHE",
        "APP_CONFIG_CACHE",
        "APP_ROUTES_CACHE",
      ],
    },
  ],
});
const model = `<?php
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Casts\\Attribute;
class SyntheticUser extends Model {
    /** @return Attribute<int, never> */
    protected function score(): Attribute { return Attribute::make(get: fn (): int => 42); }
}
function readScore(SyntheticUser $user): int { return $user->score; }
`;
const config = `includes:
    - vendor/larastan/larastan/extension.neon
parameters:
    level: 5
    disableMigrationScan: true
    disableSchemaScan: true
    enableMigrationCache: false
`;
const generated =
  "<?php class SyntheticGenerated { public static function value(): int { return 42; } }\n";
const bootstrap = `<?php
return Illuminate\\Foundation\\Application::configure(basePath: dirname(__DIR__))
    ->withExceptions()->create();
`;
async function replace(file: string, value: string) {
  const next = file + ".replacement";
  await writeFile(next, value);
  await rename(next, file);
}

test("Larastan project configuration remains execution-free during inspection and requires operator trust", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": policy,
    "phpstan.neon": config,
    "User.php": model,
    "bootstrap/app.php": "<?php file_put_contents('executed','yes');",
  });
  const plan = (await createPlan(root)).plan;
  assert.equal(plan.checks[0]!.id, "php.phpstan");
  assert.match(plan.checks[0]!.unavailableReason!, /not installed/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
});

test(
  "native Larastan proves typed model accessors with missing-extension broken fixed near-miss exclusion and bootstrap controls",
  {
    skip: available
      ? false
      : "PHP or pinned Larastan framework profile unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, {
      "composer.json": "{}",
      "checktrail.json": policy,
      "phpstan.neon": config,
      "User.php": model,
      "bootstrap/app.php": bootstrap,
      "bootstrap/providers.php": "<?php return [];\n",
      "generated/Stub.php": generated,
      ".checktrail/keep": "",
    });
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    const installed = JSON.parse(
      await readFile(path.join(root, "vendor/composer/installed.json"), "utf8"),
    ) as { packages: { name: string; version: string }[] };
    for (const [name, version] of [
      ["larastan/larastan", "v3.12.3"],
      ["laravel/framework", "v13.32.0"],
      ["phpstan/phpstan", "2.2.14"],
    ])
      assert.equal(
        installed.packages.find((entry) => entry.name === name)?.version,
        version,
      );
    const options = {
      trusted: true,
      environment: {
        APP_PACKAGES_CACHE: path.join(root, ".checktrail/packages.php"),
        APP_SERVICES_CACHE: path.join(root, ".checktrail/services.php"),
        APP_CONFIG_CACHE: path.join(root, ".checktrail/config.php"),
        APP_ROUTES_CACHE: path.join(root, ".checktrail/routes.php"),
      },
    };
    const missingEnvironment = await validate(root, { trusted: true });
    assert.equal(missingEnvironment.outcome, "incomplete");
    assert.equal(missingEnvironment.checks[0]!.status, "unavailable");
    assert.equal(missingEnvironment.checks[0]!.processes.length, 0);
    const missingCache = await validate(root, {
      ...options,
      environment: {
        ...options.environment,
        APP_PACKAGES_CACHE: path.join(root, ".checktrail/missing/packages.php"),
      },
    });
    assert.equal(
      missingCache.outcome,
      "incomplete",
      JSON.stringify(missingCache.checks),
    );
    assert.equal(missingCache.checks[0]!.status, "error");
    assert.equal(missingCache.checks[0]!.findings?.length ?? 0, 0);
    let report = await validate(root, options);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "phpstan")?.version,
      "2.2.14",
    );
    await replace(
      path.join(root, "phpstan.neon"),
      "parameters:\n    level: 5\n",
    );
    const absent = await validate(root, options);
    assert.equal(absent.outcome, "failed", JSON.stringify(absent.checks));
    assert.ok(
      absent.checks[0]!.findings?.some(
        (finding) => finding.ruleId === "property.notFound",
      ),
    );
    await replace(path.join(root, "phpstan.neon"), config);
    await replace(
      path.join(root, "User.php"),
      model.replace(
        "function readScore(SyntheticUser $user): int",
        "function readScore(SyntheticUser $user): string",
      ),
    );
    report = await validate(root, options);
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.ok(
      report.checks[0]!.findings?.some(
        (finding) =>
          finding.ruleId === "return.type" && finding.file === "User.php",
      ),
    );
    await replace(path.join(root, "User.php"), model);
    assert.equal((await validate(root, options)).outcome, "passed");
    await replace(
      path.join(root, "generated/Stub.php"),
      generated.replace("return 42", "return 'wrong'"),
    );
    report = await validate(root, options);
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.ok(
      report.checks[0]!.findings?.some(
        (finding) =>
          finding.file === "generated/Stub.php" &&
          finding.ruleId === "return.type",
      ),
    );
    await replace(path.join(root, "generated/Stub.php"), generated);
    await replace(
      path.join(root, "User.php"),
      model.replace(
        "function readScore(SyntheticUser $user): int { return $user->score; }",
        "function readScore(SyntheticUser $user): string { return (string) $user->score; }",
      ),
    );
    report = await validate(root, options);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    await replace(
      path.join(root, "phpstan.neon"),
      config + "    excludePaths:\n        analyse:\n            - User.php\n",
    );
    report = await validate(root, options);
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    await replace(path.join(root, "phpstan.neon"), config);
    await replace(path.join(root, "User.php"), model);
    await replace(
      path.join(root, "bootstrap/app.php"),
      "<?php throw new RuntimeException('synthetic bootstrap failure');\n",
    );
    report = await validate(root, options);
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findings?.length ?? 0, 0);
    await replace(path.join(root, "bootstrap/app.php"), bootstrap);
    assert.equal((await validate(root, options)).outcome, "passed");
    assert.equal(await readFile(path.join(root, "User.php"), "utf8"), model);
  },
);
