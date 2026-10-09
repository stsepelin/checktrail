import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import {
  phpOriginal,
  phpReceipt,
  phpExtensionsSkip as skip,
  phpAtomic,
  phpModel,
  phpProxy,
  phpRebind,
} from "./php-extensions-fixture.js";
test(
  "native PHP extension proves inherited defaults generated proxy origins and getter values with distinct same-first inputs",
  { skip, timeout: 120000 },
  async (t) => {
    const f = await phpOriginal(t);
    let report = await validate(f.root, f.options);
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.deepEqual(
      report.checks.map((c) => [c.id, c.status]),
      [
        ["php.phpstan", "failed"],
        ["php.php-cs-fixer", "failed"],
        ["php.extensions", "failed"],
      ],
    );
    const check = report.checks[2]!;
    assert.equal(check.findingsComplete, true);
    assert.deepEqual(
      check.findings?.map((f) => [f.ruleId, f.file]),
      [
        ["php.accessor", "Item.php"],
        ["php.accessor", "Item.php"],
      ],
    );
    const receipt = await phpReceipt(check);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.models[0]!.class, "Original\\GeneratedProxy");
    assert.equal(receipt.models[0]!.probes.length, 2);
    await phpAtomic(path.join(f.root, "Item.php"), phpModel);
    await phpAtomic(path.join(f.root, f.proxyPath), phpProxy);
    await phpRebind(f.root, f.config);
    report = await validate(f.root, f.options);
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.deepEqual(
      (await phpReceipt(report.checks[2]!)).models[0]!.probes.map(
        (p) => p.value,
      ),
      [
        { type: "string", value: "Nova Vale" },
        { type: "string", value: "Nova North" },
      ],
    );
    assert.equal(
      await readFile(path.join(f.root, ".checktrail/keep"), "utf8"),
      "original-public-cache-marker",
    );
    await assert.rejects(
      access(path.join(f.root, "bootstrap/cache/packages.php")),
    );
  },
);
test(
  "native PHP extension accounts for excluded generated source bytes beyond the project inventory",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t, {
      fixed: true,
      excludedProxy: true,
      checks: ["php.extensions"],
    });
    const plan = (await createPlan(f.root)).plan;
    assert.equal(plan.checks[0]!.scope.includes(f.proxyPath), true);
    assert.equal((await validate(f.root, f.options)).outcome, "passed");
    await phpAtomic(
      path.join(f.root, f.proxyPath),
      phpProxy + "// original changed excluded generator output\n",
    );
    const changed = (await createPlan(f.root)).plan;
    assert.match(changed.checks[0]!.unavailableReason!, /source bytes changed/);
  },
);
test(
  "native PHP extension rechecks excluded generated source after successful accessor witnesses",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t, {
      fixed: true,
      excludedProxy: true,
      checks: ["php.extensions"],
    });
    const original = await readFile(path.join(f.root, "Item.php"), "utf8");
    const changed = original.replace(
      "return Attribute::make(get: fn (mixed $value, array $attributes): string => $attributes['first'] . ' ' . $attributes['last']);",
      "return Attribute::make(get: function (mixed $value, array $attributes): string { $file = __DIR__ . '/.checktrail/generated/Proxy.php'; file_put_contents($file, file_get_contents($file) . '\\n// original post-witness source change'); return $attributes['first'] . ' ' . $attributes['last']; });",
    );
    assert.notEqual(changed, original);
    await phpAtomic(path.join(f.root, "Item.php"), changed);
    await phpRebind(f.root, f.config);
    const report = await validate(f.root, f.options);
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.status, "inconclusive");
    const receipt = JSON.parse(report.checks[0]!.processes[0]!.stdout) as {
      inputsStable: boolean;
      models: Array<{ probes: Array<{ value: unknown }> }>;
    };
    assert.equal(receipt.inputsStable, false);
    assert.deepEqual(
      receipt.models[0]!.probes.map((p) => p.value),
      [
        { type: "string", value: "Nova Vale" },
        { type: "string", value: "Nova North" },
      ],
    );
  },
);
test(
  "native PHP accessor array witnesses preserve nested scalar types instead of borrowing JSON number equality",
  { skip, timeout: 90000 },
  async (t) => {
    const f = await phpOriginal(t, { fixed: true, checks: ["php.extensions"] });
    let model = phpModel
      .replace(
        "/** @return Attribute<string, never> */",
        "/** @return Attribute<array{n: float}, never> */",
      )
      .replace(
        "function displayName(): Attribute",
        "function displayName(): Attribute",
      )
      .replace(
        "fn (mixed $value, array $attributes): string => $attributes['first'] . ' ' . $attributes['last']",
        "fn (mixed $value, array $attributes): array => ['n' => (float) $attributes['payload']['n']]",
      );
    await phpAtomic(path.join(f.root, "Item.php"), model);
    f.config.models[0]!.probes = [
      {
        attribute: "display_name",
        attributes: { payload: { n: 1 } },
        expected: {
          type: "array",
          value: [
            {
              key: { type: "string", value: "n" },
              value: { type: "int", value: 1 },
            },
          ],
        },
      },
    ];
    await phpRebind(f.root, f.config);
    const broken = await validate(f.root, f.options);
    assert.equal(broken.checks[0]!.status, "failed");
    assert.deepEqual(
      broken.checks[0]!.findings?.map((f) => f.ruleId),
      ["php.accessor"],
    );
    assert.equal(broken.checks[0]!.findingsComplete, true);
    model = model.replace(
      "(float) $attributes['payload']['n']",
      "(int) $attributes['payload']['n']",
    );
    await phpAtomic(path.join(f.root, "Item.php"), model);
    await phpRebind(f.root, f.config);
    assert.equal((await validate(f.root, f.options)).outcome, "passed");
  },
);
