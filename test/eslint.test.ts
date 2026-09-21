import assert from "node:assert/strict";
import { access, readFile, symlink, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";
import { copyESLint, eslintConfig, eslintPolicy } from "./eslint-helpers.js";

test(
  "native ESLint catches errors and warnings, preserves caches, and accounts for ignored and unconfigured files",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": "{}",
      "repo-verifier.json": eslintPolicy("app"),
      "app/package.json": '{"type":"module"}',
      "app/eslint.config.js": eslintConfig,
      "app/src/valid [case] with spaces.js":
        "export const value = 'debugger;';\n",
      "app/.eslintcache": "existing cache must survive",
    });
    await copyESLint(root);
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.sourceChanged, false);
    assert.equal(
      await readFile(path.join(root, "app/.eslintcache"), "utf8"),
      "existing cache must survive",
    );
    await writeFile(path.join(root, "app/src/broken.js"), "debugger;\n");
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.match(broken.checks[0]!.processes[0]!.stdout, /no-debugger/);
    await writeFile(path.join(root, "app/src/broken.js"), "export const = ;\n");
    const syntax = await validate(root, { trusted: true });
    assert.equal(syntax.outcome, "failed");
    assert.match(syntax.checks[0]!.processes[0]!.stdout, /"fatalErrorCount":1/);
    await writeFile(path.join(root, "app/src/broken.js"), "debugger;\n");
    await writeFile(
      path.join(root, "app/eslint.config.js"),
      "export default [{rules: {'no-debugger': 'warn'}}];\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await writeFile(
      path.join(root, "app/eslint.config.js"),
      "export default [{ignores:['src/broken.js']},{rules:{'no-debugger':'error'}}];\n",
    );
    const ignored = await validate(root, { trusted: true });
    assert.equal(ignored.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(ignored.outcome, "incomplete");
    await writeFile(path.join(root, "app/eslint.config.js"), eslintConfig);
    await writeFile(
      path.join(root, "app/src/broken.js"),
      "export const valid = 42;\n",
    );
    await writeFile(
      path.join(root, "app/src/unconfigured.ts"),
      "export const valid: number = 42;\n",
    );
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
    );
  },
);

test("ESLint planning never executes the configuration or installed tool and reports missing prerequisites", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "repo-verifier.json": eslintPolicy(),
    "eslint.config.js":
      "import fs from 'node:fs'; fs.writeFileSync('executed', 'yes'); export default [];",
    "source.js": "debugger;",
  });
  let report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "unavailable");
  await mkdir(path.join(root, "node_modules/eslint/lib"), { recursive: true });
  await writeFile(
    path.join(root, "node_modules/eslint/lib/api.js"),
    "require('node:fs').writeFileSync('executed', 'yes')",
  );
  const { plan } = await createPlan(root);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await assert.rejects(access(path.join(root, "executed")));
  await writeFile(path.join(root, "eslint.config.mjs"), "export default [];");
  report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "unavailable");
  assert.equal(report.checks[0]!.processes.length, 0);
});

test("ESLint does not load an installation linked outside the configured root", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "repo-verifier.json": eslintPolicy(),
    "eslint.config.js": eslintConfig,
  });
  await mkdir(path.join(root, "node_modules"));
  await symlink(
    path.dirname(path.dirname(fileURLToPath(import.meta.resolve("eslint")))),
    path.join(root, "node_modules/eslint"),
    "dir",
  );
  const report = await validate(root, { trusted: true });
  assert.equal(report.checks[0]!.status, "unavailable");
  assert.equal(report.checks[0]!.processes.length, 0);
});

test(
  "ESLint with no enabled rules is incomplete and a broken configuration is an execution error",
  { timeout: 15_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "repo-verifier.json": eslintPolicy(),
      "eslint.config.js": "export default [{rules: {'no-debugger': 'off'}}];\n",
      "source.js": "debugger;\n",
    });
    await copyESLint(root);
    const empty = await validate(root, { trusted: true });
    assert.equal(empty.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(empty.outcome, "incomplete");
    await writeFile(
      path.join(root, "eslint.config.js"),
      "throw new Error('synthetic bad config');",
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "incomplete");
    assert.equal(broken.checks[0]!.status, "error");
    assert.match(
      broken.checks[0]!.processes[0]!.stderr,
      /synthetic bad config/,
    );
  },
);
