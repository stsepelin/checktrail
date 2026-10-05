import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, cp, readFile, rename, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { phpCsFixerEvidence } from "../src/php-cs-fixer-evidence.js";
import type { Check, ProcessResult } from "../src/types.js";

const vendor = fileURLToPath(
  new URL("../../.checktrail/php-review-tools/vendor", import.meta.url),
);
const prepared = await access(
  path.join(vendor, "friendsofphp/php-cs-fixer/src/Console/Application.php"),
).then(
  () => true,
  () => false,
);
const available =
  prepared && spawnSync("php", ["--version"], { timeout: 10000 }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["php.php-cs-fixer"] }],
});
const good = "<?php\n\nfunction value(): int\n{\n    return 42;\n}\n";
const config = `<?php
$counter = __DIR__.'/.checktrail/config-loads';
file_put_contents($counter, (string) (is_file($counter) ? ((int) file_get_contents($counter)) + 1 : 1));
return (new PhpCsFixer\\Config())->setRules(['braces_position'=>true, 'indentation_type'=>true])
 ->setUsingCache(true)->setCacheFile(__DIR__.'/.checktrail/configured-cache')
 ->setFinder(PhpCsFixer\\Finder::create()->in(__DIR__));`;
async function replace(file: string, value: string) {
  const temporary = file + ".replacement";
  await writeFile(temporary, value);
  await rename(temporary, file);
}

test("PHP-CS-Fixer planning requires local config and tools and does not execute PHP", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": policy,
    "Example.php": good,
    "view.blade.php": "<p>example</p>",
    ".php-cs-fixer.php": "<?php file_put_contents(__DIR__.'/executed', 'yes');",
  });
  const check = (await createPlan(root)).plan.checks[0]!;
  assert.deepEqual(check.scope, ["Example.php"]);
  assert.match(check.unavailableReason!, /not installed/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")), { code: "ENOENT" });
});

test(
  "native PHP-CS-Fixer processes declared files and catches style syntax exclusions and skipped input without writing source or cache",
  {
    skip: available ? false : "PHP or pinned PHP review tools unavailable",
    timeout: 120000,
  },
  async (t) => {
    const root = await fixture(t, {
      "composer.json": "{}",
      "checktrail.json": policy,
      "Example with spaces.php": good,
      "Second.php": good.replace("value", "second"),
      ".php-cs-fixer.php": config,
      ".checktrail/configured-cache": "preserve",
    });
    await cp(vendor, path.join(root, "vendor"), { recursive: true });
    let report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, ".checktrail/config-loads"), "utf8"),
      "1",
    );
    assert.equal(
      report.checks[0]!.tools?.find((tool) => tool.name === "php-cs-fixer")
        ?.version,
      "3.95.27",
    );
    const before = await readFile(
      path.join(root, "Example with spaces.php"),
      "utf8",
    );
    const broken = before.replace("\n{", " {");
    await replace(path.join(root, "Example with spaces.php"), broken);
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.equal(report.sourceChanged, false);
    assert.equal(report.checks[0]!.findingsComplete, true);
    assert.equal(
      await readFile(path.join(root, ".checktrail/config-loads"), "utf8"),
      "2",
    );
    assert.ok(
      report.checks[0]!.findings?.some(
        (finding) =>
          finding.ruleId === "braces_position" &&
          finding.file === "Example with spaces.php",
      ),
    );
    assert.equal(
      await readFile(path.join(root, "Example with spaces.php"), "utf8"),
      broken,
    );
    assert.equal(
      await readFile(path.join(root, ".checktrail/configured-cache"), "utf8"),
      "preserve",
    );
    await replace(path.join(root, "Example with spaces.php"), good);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "Example with spaces.php"),
      "<?php function value( {\n",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "failed", JSON.stringify(report.checks));
    assert.ok(
      report.checks[0]!.findings?.some(
        (finding) => finding.ruleId === "syntax",
      ),
    );
    await replace(path.join(root, "Example with spaces.php"), good);
    await replace(
      path.join(root, ".php-cs-fixer.php"),
      config.replace(
        "->in(__DIR__)",
        "->in(__DIR__)->exclude('ignored')->notName('Second.php')",
      ),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    await replace(path.join(root, ".php-cs-fixer.php"), config);
    await replace(path.join(root, "Second.php"), "");
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    const packet = JSON.parse(report.checks[0]!.processes[0]!.stdout) as {
      events: { status: number }[];
    };
    assert.ok(packet.events.some((e) => e.status === 2));
    await replace(
      path.join(root, "Second.php"),
      good.replace("value", "second"),
    );
    await replace(
      path.join(root, ".php-cs-fixer.php"),
      config.replace(
        "['braces_position'=>true, 'indentation_type'=>true]",
        "[]",
      ),
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "error");
    await replace(
      path.join(root, ".php-cs-fixer.php"),
      "<?php throw new RuntimeException('invalid configuration');",
    );
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findings?.length ?? 0, 0);
    await replace(path.join(root, ".php-cs-fixer.php"), config);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    const application = path.join(
      root,
      "vendor/friendsofphp/php-cs-fixer/src/Console/Application.php",
    );
    const pinned = await readFile(application, "utf8");
    assert.equal(pinned.split("3.95.27").length - 1, 1);
    await replace(application, pinned.replace("3.95.27", "3.95.28"));
    report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "error");
    assert.equal(report.checks[0]!.findings?.length ?? 0, 0);
    await replace(application, pinned);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test("PHP-CS-Fixer evidence requires exact native events rules totals exits and active coverage", () => {
  const check: Check = {
    id: "php.php-cs-fixer",
    adapter: "php",
    project: ".",
    kind: "format",
    parser: "php-cs-fixer-json",
    scope: ["Example.php", "Second.php"],
    commands: [],
    reason: "synthetic",
  };
  const value = {
    version: "3.95.27",
    files: ["Example.php", "Second.php"],
    fixers: ["braces_position"],
    events: [
      { file: "Example.php", status: 3 },
      { file: "Second.php", status: 3 },
    ],
    changes: [],
    errors: [],
    blocked: null,
    dryRun: true,
    usingCache: false,
    exitCode: 0,
  };
  const process: ProcessResult = {
    command: { executable: "php", args: [], cwd: "." },
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  assert.equal(
    phpCsFixerEvidence(check, [process], "/synthetic").status,
    "passed",
  );
  for (const patch of [
    { files: ["Example.php"] },
    { events: [{ file: "Example.php", status: 3 }] },
    {
      events: [
        { file: "Example.php", status: 3 },
        { file: "Example.php", status: 3 },
      ],
    },
    { fixers: [] },
    { dryRun: false },
    { usingCache: true },
    { version: "3.95.28" },
    { exitCode: 8 },
    { blocked: "environment unavailable" },
    {
      events: [
        { file: "Example.php", status: 2 },
        { file: "Second.php", status: 3 },
      ],
    },
  ]) {
    assert.notEqual(
      phpCsFixerEvidence(
        check,
        [{ ...process, stdout: JSON.stringify({ ...value, ...patch }) }],
        "/synthetic",
      ).status,
      "passed",
    );
  }
  const changed = {
    ...value,
    exitCode: 8,
    events: [
      { file: "Example.php", status: 4 },
      { file: "Second.php", status: 3 },
    ],
    changes: [
      {
        file: "Example.php",
        fixers: ["braces_position"],
        diff: "@@ -3 +3 @@\n-function value() {\n+function value()",
      },
    ],
  };
  const failure = phpCsFixerEvidence(
    check,
    [{ ...process, exitCode: 8, stdout: JSON.stringify(changed) }],
    "/synthetic",
  );
  assert.equal(failure.status, "failed");
  assert.equal(failure.findingsComplete, true);
  assert.equal(failure.findings?.[0]?.line, undefined);
  for (const patch of [
    { events: value.events },
    { changes: [{ ...changed.changes[0], fixers: ["unconfigured_rule"] }] },
    { changes: [{ ...changed.changes[0], file: "../foreign.php" }] },
  ]) {
    assert.equal(
      phpCsFixerEvidence(
        check,
        [
          {
            ...process,
            exitCode: 8,
            stdout: JSON.stringify({ ...changed, ...patch }),
          },
        ],
        "/synthetic",
      ).status,
      "inconclusive",
    );
  }
  assert.notEqual(
    phpCsFixerEvidence(
      check,
      [{ ...process, stderr: "runtime warning" }],
      "/synthetic",
    ).status,
    "passed",
  );
});
