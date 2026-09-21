import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
import { fixture } from "./helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";

const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["javascript.playwright"] }],
});
const prelude = "import { test, expect } from '@playwright/test';\n";
const good = prelude + "test('adds', () => expect(2+3).toBe(5));\n";

test(
  "native Playwright accounts for tests, failures, focus, skips, retries and omitted files",
  { timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": policy,
      "math.spec.js": good,
      "playwright.config.js":
        "export default { retries: 1, grep: /never-match/, grepInvert: /.*/, shard: {current:1,total:20}, reporter: './never-load.cjs', outputDir:'preserved-output' };",
      "never-load.cjs": "throw new Error('project reporter must not run');",
      "preserved-output/sentinel.txt": "keep",
    });
    await copyInstalledPackages(root, ["@playwright/test"]);
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
      await readFile(path.join(root, "preserved-output/sentinel.txt"), "utf8"),
      "keep",
    );
    for (const [source, outcome] of [
      ["test('fails',()=>expect(1).toBe(2));", "failed"],
      [
        "test.only('focus',()=>expect(1).toBe(1)); test('hidden failure',()=>expect(1).toBe(2));",
        "failed",
      ],
      ["test.skip('skip',()=>{});", "incomplete"],
      [
        "test('expected failure',()=>{test.fail();expect(1).toBe(2)});",
        "incomplete",
      ],
      [
        "test('unexpected pass',()=>{test.fail();expect(1).toBe(1)});",
        "failed",
      ],
      ["test('flaky',({},info)=>expect(info.retry).toBe(1));", "failed"],
      [
        "test('snapshot',()=>expect('synthetic').toMatchSnapshot('value.txt'));",
        "failed",
      ],
      [
        "test.beforeEach(()=>{throw new Error('setup failed')}); test('blocked',()=>expect(1).toBe(1));",
        "failed",
      ],
      ["throw new Error('synthetic import error');", "failed"],
      ["", "failed"],
    ]) {
      await writeFile(path.join(root, "math.spec.js"), prelude + source!);
      const report = await validate(root, { trusted: true });
      assert.equal(
        report.outcome,
        outcome,
        `${source}\n${JSON.stringify(report.checks)}`,
      );
      assert.equal(report.sourceChanged, false, source);
    }
    await assert.rejects(access(path.join(root, "math.spec.js-snapshots")));
    await writeFile(path.join(root, "math.spec.js"), good);
    await writeFile(path.join(root, "omitted.spec.js"), good);
    await writeFile(
      path.join(root, "playwright.config.js"),
      "export default {testIgnore:'**/omitted.spec.js'};",
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(excluded.outcome, "incomplete");
  },
);

test(
  "Playwright planning does not execute config and native guards reject unsupported startup and snapshots bypass",
  { timeout: 60_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": policy,
      "math.spec.js": good,
      "playwright.config.ts":
        "throw new Error('config executed'); export default {};",
    });
    assert.equal(
      (await createPlan(root)).plan.checks[0]!.unavailableReason,
      "Playwright is not installed within the configured root.",
    );
    await copyInstalledPackages(root, ["@playwright/test"]);
    assert.equal(
      (await createPlan(root)).plan.checks[0]!.unavailableReason,
      undefined,
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await writeFile(
      path.join(root, "playwright.config.ts"),
      "export default {webServer:{command:'touch server-started',url:'http://127.0.0.1:1'}};",
    );
    const blocked = await validate(root, { trusted: true });
    assert.equal(blocked.outcome, "incomplete");
    assert.match(blocked.checks[0]!.processes[0]!.stderr, /webServer/);
    await assert.rejects(access(path.join(root, "server-started")));
    await writeFile(
      path.join(root, "playwright.config.ts"),
      "export default {ignoreSnapshots:true,updateSnapshots:'all',projects:[{name:'first',grep:/never/,ignoreSnapshots:true},{name:'second'}]};",
    );
    await writeFile(
      path.join(root, "math.spec.js"),
      prelude +
        "test('snapshot',()=>expect('value').toMatchSnapshot('saved.txt'));",
    );
    const snapshots = await validate(root, { trusted: true });
    assert.equal(snapshots.outcome, "failed", JSON.stringify(snapshots.checks));
    assert.equal(snapshots.checks[0]!.tests?.total, 2);
    assert.equal(snapshots.sourceChanged, false);
    await writeFile(path.join(root, "math.spec.js"), good);
    const projects = await validate(root, { trusted: true });
    assert.equal(projects.outcome, "passed", JSON.stringify(projects.checks));
    assert.equal(projects.checks[0]!.tests?.passed, 2);
    await writeFile(
      path.join(root, "playwright.config.ts"),
      "export default {projects:[{name:'first'},{name:'empty',testIgnore:'**/*'}]};",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await writeFile(
      path.join(root, "playwright.config.ts"),
      "export default {projects:[{name:'same'},{name:'same'}]};",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
    await writeFile(
      path.join(root, "playwright.config.ts"),
      "export default {'@playwright/test':{plugins:[()=>{throw new Error('private plugin ran')} ]}};",
    );
    const plugins = await validate(root, { trusted: true });
    assert.equal(plugins.outcome, "incomplete");
    assert.match(
      plugins.checks[0]!.processes[0]!.stderr,
      /private runner plugins/,
    );
    const metadataFile = path.join(
      root,
      "node_modules/playwright/package.json",
    );
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    await writeFile(
      metadataFile,
      JSON.stringify({ ...metadata, version: "1.62.0" }),
    );
    const version = await validate(root, { trusted: true });
    assert.equal(version.outcome, "incomplete");
    assert.match(version.checks[0]!.processes[0]!.stderr, /verified version/);
  },
);

test("Playwright evidence rejects duplicate, missing, inconsistent and interrupted test results", () => {
  const command = { executable: "synthetic", args: [], cwd: "." };
  const check: Check = {
    id: "javascript.playwright",
    adapter: "javascript",
    project: ".",
    scope: ["math.spec.js"],
    kind: "test",
    parser: "playwright-json",
    reason: "synthetic",
    commands: [command],
  };
  const process: ProcessResult = {
    command,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
  const example = {
    id: "one",
    project: "",
    file: "/synthetic/math.spec.js",
    expectedStatus: "passed",
    outcome: "expected",
    results: [{ status: "passed", retry: 0, errors: [] as string[] }],
  };
  const evidence = {
    version: 1,
    projects: [""],
    status: "passed",
    errors: [],
    tests: [example],
  };
  const parse = (value: unknown) =>
    evaluate(
      check,
      [{ ...process, stdout: JSON.stringify(value) }],
      "/synthetic",
    );
  assert.equal(parse(evidence).status, "passed");
  assert.equal(
    parse({ ...evidence, projects: ["", "empty"] }).status,
    "inconclusive",
  );
  assert.equal(
    parse({ ...evidence, projects: ["", ""] }).status,
    "inconclusive",
  );
  const missing = {
    ...example,
    outcome: "unexpected",
    results: [
      {
        status: "failed",
        retry: 0,
        errors: ["browserType.launch: Executable doesn't exist at synthetic"],
      },
    ],
  };
  assert.equal(
    parse({ ...evidence, status: "failed", tests: [missing] }).status,
    "unavailable",
  );
  assert.equal(
    parse({
      ...evidence,
      status: "failed",
      tests: [
        missing,
        {
          ...missing,
          id: "assertion",
          results: [{ status: "failed", retry: 0, errors: ["wrong value"] }],
        },
      ],
    }).status,
    "failed",
  );
  for (const tests of [
    [],
    [example, example],
    [{ ...example, file: "/outside/math.spec.js" }],
    [{ ...example, results: [] }],
    [
      {
        ...example,
        results: [{ status: "failed", retry: 0, errors: ["failed"] }],
      },
    ],
    [{ ...example, results: [{ status: "passed", retry: 1, errors: [] }] }],
    [
      {
        ...example,
        results: [{ status: "passed", retry: 0, errors: ["hidden"] }],
      },
    ],
  ])
    assert.equal(parse({ ...evidence, tests }).status, "inconclusive");
  assert.equal(
    parse({ ...evidence, status: "interrupted" }).status,
    "inconclusive",
  );
  assert.equal(
    evaluate(
      check,
      [{ ...process, stdout: JSON.stringify(evidence), truncated: true }],
      "/synthetic",
    ).status,
    "inconclusive",
  );
});

test(
  "native Playwright validates browser DOM assertions and reports an absent browser as unavailable",
  { timeout: 60_000 },
  async (t) => {
    const browserDirectory = path.resolve(".checktrail/playwright-browsers");
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["javascript.playwright"],
            environment: ["PLAYWRIGHT_BROWSERS_PATH"],
          },
        ],
      }),
      "browser.spec.js":
        prelude +
        "test('page state',async({page})=>{await page.setContent('<button>Save</button>');await expect(page.getByRole('button')).toHaveText('Save');});",
      "playwright.config.js":
        "export default {timeout:5000,expect:{timeout:500}};",
    });
    await copyInstalledPackages(root, ["@playwright/test"]);
    const missing = await validate(root, {
      trusted: true,
      environment: {
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "missing-browsers"),
      },
    });
    assert.equal(
      missing.checks[0]!.status,
      "unavailable",
      JSON.stringify(missing.checks),
    );
    assert.equal(missing.outcome, "incomplete");
    try {
      await access(browserDirectory);
    } catch {
      t.skip(
        "Prepared Chromium is absent; real-browser assertion cases require the documented preparation.",
      );
      return;
    }
    const options = {
      trusted: true,
      environment: { PLAYWRIGHT_BROWSERS_PATH: browserDirectory },
    };
    const passed = await validate(root, options);
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.checks[0]!.tests?.passed, 1);
    assert.equal(passed.sourceChanged, false);
    await writeFile(
      path.join(root, "browser.spec.js"),
      prelude +
        "test('page state',async({page})=>{await page.setContent('<button>Save</button>');await expect(page.getByRole('button')).toHaveText('Delete');});",
    );
    const failed = await validate(root, options);
    assert.equal(failed.outcome, "failed", JSON.stringify(failed.checks));
    assert.equal(failed.checks[0]!.tests?.failed, 1);
    assert.match(failed.checks[0]!.processes[0]!.stdout, /Delete/);
  },
);
