import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { compareRuntimeInventories } from "../src/runtime-inventory.js";
import { projectReport } from "../src/output.js";
import { fixture } from "./helpers.js";

const vendor = fileURLToPath(
  new URL("../../.repo-verifier/laravel-tools/vendor", import.meta.url),
);
const available = await access(path.join(vendor, "autoload.php")).then(
  () => spawnSync("php", ["--version"], { timeout: 10_000 }).status === 0,
  () => false,
);
const example = new URL("../../examples/frameworks/laravel/", import.meta.url);
const policy = await readFile(new URL("repo-verifier.json", example), "utf8");
const profile = await readFile(
  new URL("repo-verifier.laravel.json", example),
  "utf8",
);
const manifest = await readFile(new URL("composer.json", example), "utf8");
const providers = await readFile(
  new URL("bootstrap/providers.php", example),
  "utf8",
);
const applicationConfig = await readFile(
  new URL("config/app.php", example),
  "utf8",
);
const bootstrap = await readFile(
  new URL(
    "../../examples/frameworks/laravel/bootstrap/app.php",
    import.meta.url,
  ),
  "utf8",
);
const wiring = await readFile(
  new URL("../../examples/frameworks/laravel/wiring.php", import.meta.url),
  "utf8",
);
const files = () => ({
  "composer.json": manifest,
  "repo-verifier.json": policy,
  "repo-verifier.laravel.json": profile,
  "bootstrap/app.php": bootstrap,
  "bootstrap/providers.php": providers,
  "wiring.php": wiring,
  "config/app.php": applicationConfig,
});

test("Laravel planning is read-only, requires local prerequisites and protects the testing environment", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "bootstrap/app.php": "<?php file_put_contents('executed', 'yes');\n",
  });
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /local vendor/,
  );
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await mkdir(path.join(root, "vendor"));
  await writeFile(
    path.join(root, "vendor/autoload.php"),
    "<?php file_put_contents('autoloaded', 'yes');",
  );
  assert.deepEqual((await createPlan(root)).plan.checks[0]!.scope, [
    "bootstrap/app.php",
  ]);
  await assert.rejects(access(path.join(root, "autoloaded")));
  const configured = JSON.parse(policy);
  configured.projects[0].environment = ["APP_ENV"];
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify(configured),
  );
  await assert.rejects(
    createPlan(root, { environment: { APP_ENV: "production" } }),
    /protected adapter/,
  );
  await writeFile(path.join(root, "repo-verifier.json"), policy);

  await writeFile(
    path.join(root, "repo-verifier.laravel.json"),
    profile.replace("testing", "production"),
  );
  await assert.rejects(createPlan(root));
  await writeFile(
    path.join(root, "repo-verifier.laravel.json"),
    "invalid JSON",
  );
  await writeFile(
    path.join(root, "repo-verifier.json"),
    policy.replace("php.laravel-runtime", "php.syntax"),
  );
  assert.equal((await createPlan(root)).plan.checks[0]!.id, "php.syntax");
});

test(
  "native Laravel captures all five assembly projections, including wildcard listeners and concrete bindings, without running application work",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 120_000,
  },
  async (t) => {
    const root = await fixture(t, files());
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    const before = await validate(root, { trusted: true });
    assert.equal(before.outcome, "passed", JSON.stringify(before.checks));
    assert.equal(before.sourceChanged, false);
    assert.equal(
      before.checks[0]!.tools?.find((tool) => tool.name === "laravel")?.version,
      "13.32.0",
    );
    const runtime = before.checks[0]!.runtime!;
    const collection = (kind: string) =>
      runtime.collections.find((item) => item.kind === kind)!;
    assert.deepEqual(
      collection("routes").entries.find(
        (entry) => entry.attributes.uri === "catalog",
      )!.attributes.middleware,
      ["SyntheticAuth"],
    );
    assert.deepEqual(
      collection("routes").entries.find(
        (entry) => entry.attributes.uri === "catalog-extra",
      )!.attributes.middleware,
      ["SyntheticGuest"],
    );
    assert.ok(
      collection("routes").entries.some(
        (entry) => entry.attributes.uri === "storage/{path}",
      ),
    );
    assert.equal(
      collection("listeners").entries.filter(
        (entry) => entry.attributes.event === "synthetic.*",
      ).length,
      1,
    );
    assert.equal(
      collection("bindings").entries.find(
        (entry) => entry.key === "factory:synthetic.catalog",
      )!.attributes.target,
      "CatalogService",
    );
    assert.equal(
      collection("bindings").entries.find(
        (entry) => entry.key === "contextual:CatalogConsumer:CatalogService",
      )!.attributes.target,
      "AlternateCatalogService",
    );
    assert.equal(
      collection("schedules").entries[0]!.attributes.expression,
      "0 * * * *",
    );
    assert.ok(
      !JSON.stringify(projectReport(before, false)).includes("SyntheticAuth"),
    );
    const repeat = await validate(root, { trusted: true });
    assert.equal(repeat.outcome, "passed", JSON.stringify(repeat.checks));
    assert.equal(
      compareRuntimeInventories(runtime, repeat.checks[0]!.runtime).outcome,
      "passed",
    );
    await writeFile(
      path.join(root, "wiring.php"),
      wiring
        .replace(
          "$this->app['events']->listen('synthetic.saved', SyntheticListener::class.'@handle');",
          "$this->app['events']->listen('synthetic.saved', SyntheticListener::class.'@handle');\n        $this->app['events']->listen('synthetic.saved', SyntheticListener::class.'@handle');",
        )
        .replace("->hourly()", "->daily()")
        .replace(
          "->bind('synthetic.catalog'",
          "->singleton('synthetic.catalog'",
        )
        .replace(
          "->middleware('synthetic.auth');",
          "->middleware('synthetic.auth-extra');",
        ),
    );
    const changed = await validate(root, { trusted: true });
    assert.equal(changed.outcome, "passed", JSON.stringify(changed.checks));
    const comparison = compareRuntimeInventories(
      runtime,
      changed.checks[0]!.runtime,
    );
    assert.equal(comparison.outcome, "failed");
    assert.deepEqual(
      comparison.collections
        .filter((item) => item.status === "changed")
        .map((item) => item.kind),
      ["bindings", "listeners", "routes", "schedules"],
    );
    assert.equal(
      comparison.collections.find((item) => item.kind === "listeners")!.added,
      1,
    );
    await writeFile(path.join(root, "wiring.php"), wiring);
    const fixed = await validate(root, { trusted: true });
    assert.equal(
      compareRuntimeInventories(runtime, fixed.checks[0]!.runtime).outcome,
      "passed",
    );
  },
);

test(
  "native Laravel ignores stale compiled caches and dotenv, but cannot pass empty, unsupported or failed assembly",
  {
    skip: available ? false : "PHP or prepared Laravel unavailable",
    timeout: 120_000,
  },
  async (t) => {
    const root = await fixture(t, {
      ...files(),
      "bootstrap/cache/config.php":
        "<?php throw new RuntimeException('Stale configuration loaded');\n",
      "bootstrap/cache/routes-v7.php":
        "<?php throw new RuntimeException('Stale routes loaded');\n",
      ".env.testing": "APP_ENV=production\nSYNTHETIC_SECRET=must-not-load\n",
    });
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    await writeFile(
      path.join(root, "config/app.php"),
      applicationConfig.replace(
        "<?php",
        "<?php if (getenv('SYNTHETIC_SECRET') || env('SYNTHETIC_SECRET')) throw new RuntimeException('Dotenv loaded');",
      ),
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    assert.match(
      await readFile(path.join(root, "bootstrap/cache/config.php"), "utf8"),
      /Stale configuration/,
    );
    for (const [index, source] of [
      wiring.replace(
        "function syntheticSchedule(Schedule $schedule) {",
        "function syntheticSchedule(Schedule $schedule) { Route::setRoutes(new \\Illuminate\\Routing\\RouteCollection);",
      ),
      wiring.replace(
        "$this->app['events']->listen('synthetic.saved',",
        "$this->app->singleton('events', fn () => new class extends \\Illuminate\\Events\\Dispatcher {});\n        $this->app['events']->listen('synthetic.saved',",
      ),
      wiring + "\nthrow new RuntimeException('Synthetic bootstrap failure');\n",
    ].entries()) {
      await writeFile(path.join(root, "wiring.php"), source);
      const report = await validate(root, { trusted: true });
      assert.equal(
        report.outcome,
        "incomplete",
        JSON.stringify({ index, checks: report.checks }),
      );
      if (index < 2) {
        assert.equal(report.checks[0]!.status, "inconclusive");
        assert.equal(
          report.checks[0]!.runtime!.collections.find(
            (item) => item.kind === (index === 0 ? "routes" : "listeners"),
          )!.complete,
          false,
        );
      } else {
        assert.equal(report.checks[0]!.status, "error");
        assert.match(
          report.checks[0]!.processes[0]!.stderr,
          /Synthetic bootstrap failure/,
        );
      }
    }
  },
);
