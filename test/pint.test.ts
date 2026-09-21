import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";

const packagePath = fileURLToPath(
  new URL("../../.checktrail/php-tools/vendor/laravel/pint", import.meta.url),
);
const prepared = await access(path.join(packagePath, "builds/pint")).then(
  () => true,
  () => false,
);
const available =
  prepared && spawnSync("php", ["--version"], { timeout: 10_000 }).status === 0;
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["php.pint"] }],
});
const good = "<?php\n\nfunction total(): int\n{\n    return 5;\n}\n";

async function replaceFixture(file: string, source: string): Promise<void> {
  const temporary = `${file}.replacement`;
  await writeFile(temporary, source, { flush: true });
  await rename(temporary, file);
}

test("Pint planning only resolves its installed path", async (t) => {
  const root = await fixture(t, {
    "composer.json": "{}",
    "checktrail.json": policy,
    "Example.php": good,
    "view.blade.php": "<p>{{ $value }}</p>",
  });
  assert.deepEqual((await createPlan(root)).plan.checks[0]!.scope, [
    "Example.php",
  ]);
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /not installed/,
  );
});

test(
  "native Pint proves file and rule scope, rejects errors and never fixes source or consumes configured cache",
  {
    skip: available ? false : "PHP or prepared Pint unavailable",
    timeout: 90_000,
  },
  async (t) => {
    const project = await fixture(t, {
      "composer.json": "{}",
      "checktrail.json": policy,
      "Example.php": good,
    });
    const aliases = await fixture(t, {});
    const root = path.join(aliases, "project");
    await symlink(project, root, "dir");
    await cp(packagePath, path.join(root, "vendor/laravel/pint"), {
      recursive: true,
    });
    const scratch = await fixture(t, {});
    const previousTemporary = process.env.TMPDIR;
    async function run() {
      process.env.TMPDIR = scratch;
      try {
        return await validate(root, { trusted: true });
      } finally {
        if (previousTemporary === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemporary;
        assert.deepEqual(
          await readdir(scratch),
          [],
          "Execution caches must be removed",
        );
      }
    }
    const passed = await run();
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "pint")?.version,
      "1.32.1",
    );
    assert.equal(passed.sourceChanged, false);
    await writeFile(
      path.join(root, "native-cache.json"),
      "synthetic cache sentinel",
    );
    await replaceFixture(
      path.join(root, "pint.json"),
      JSON.stringify({ "cache-file": "native-cache.json" }),
    );
    const bad = good.replace("return 5;", "return  5;");
    await replaceFixture(path.join(root, "Example.php"), bad);
    const failed = await run();
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.sourceChanged, false);
    assert.equal(await readFile(path.join(root, "Example.php"), "utf8"), bad);
    assert.equal(
      await readFile(path.join(root, "native-cache.json"), "utf8"),
      "synthetic cache sentinel",
    );
    await replaceFixture(
      path.join(root, "Example.php"),
      "<?php function broken( {\n",
    );
    const syntax = await run();
    assert.equal(syntax.outcome, "failed", JSON.stringify(syntax.checks));
    await replaceFixture(path.join(root, "Example.php"), bad);
    await replaceFixture(
      path.join(root, "pint.json"),
      '{"notName":["Example.php"]}',
    );
    const excluded = await run();
    assert.equal(excluded.outcome, "failed", JSON.stringify(excluded.checks));
    assert.deepEqual(
      JSON.parse(excluded.checks[0]!.processes[0]!.stdout).files,
      [await realpath(path.join(root, "Example.php"))],
    );
    await replaceFixture(path.join(root, "Example.php"), good);
    await replaceFixture(path.join(root, "pint.json"), '{"preset":"empty"}');
    const noRules = await run();
    assert.equal(noRules.outcome, "incomplete", JSON.stringify(noRules.checks));
    assert.match(noRules.checks[0]!.processes[0]!.stdout, /no-active-rules/);
    await replaceFixture(
      path.join(root, "pint.json"),
      '{"rules":{"Pint/laravel_blade":true}}',
    );
    const blade = await run();
    assert.equal(blade.outcome, "incomplete", JSON.stringify(blade.checks));
    assert.match(
      blade.checks[0]!.processes[0]!.stdout,
      /unverified-prettier-integration/,
    );
    await replaceFixture(path.join(root, "pint.json"), '{"preset":"missing"}');
    assert.equal((await run()).outcome, "incomplete");
    await replaceFixture(path.join(root, "pint.json"), "{}");
    await replaceFixture(
      path.join(root, "Other.php"),
      good.replace("total", "otherTotal"),
    );
    const multiple = await run();
    assert.equal(multiple.outcome, "passed", JSON.stringify(multiple.checks));
    assert.equal(multiple.checks[0]!.scope.length, 2);
  },
);

test("Pint evidence cannot pass empty rules, duplicate, omitted or unexpected files or incompatible versions", () => {
  const command = { executable: "php", args: [], cwd: "." };
  const check: Check = {
    id: "php.pint",
    adapter: "php",
    project: ".",
    scope: ["Example.php"],
    kind: "format",
    parser: "pint-json",
    commands: [command],
    reason: "synthetic",
  };
  const evidence = {
    version: "1.32.1",
    files: ["/synthetic/Example.php"],
    fixers: ["binary_operator_spaces"],
    blocked: null,
    report: JSON.stringify({ tool: "pint", result: "passed" }),
    exitCode: 0,
  };
  const process: ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(evidence),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  assert.equal(evaluate(check, [process], "/synthetic").status, "passed");
  for (const patch of [
    { files: [] },
    { files: ["/synthetic/Other.php"] },
    { files: [...evidence.files, ...evidence.files] },
    { fixers: [] },
    { blocked: "no-active-rules" },
    { version: "0.0.0" },
    { exitCode: 1 },
    { report: '{"tool":"pint","result":"fixed"}' },
  ])
    assert.equal(
      evaluate(
        check,
        [{ ...process, stdout: JSON.stringify({ ...evidence, ...patch }) }],
        "/synthetic",
      ).status,
      "inconclusive",
    );
  for (const patch of [
    { timedOut: true },
    { truncated: true },
    { cancelled: true },
  ])
    assert.equal(
      evaluate(check, [{ ...process, ...patch }], "/synthetic").status,
      "inconclusive",
    );
});
