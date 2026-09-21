import assert from "node:assert/strict";
import { access, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPlan, validate } from "../src/engine.js";
import { fixture } from "./helpers.js";

const compilerPackage = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript"))),
);
const policy = (project = ".") =>
  JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: project, checks: ["javascript.typescript"] }],
  });
const config = JSON.stringify({
  compilerOptions: {
    strict: true,
    types: [],
    incremental: true,
    noCheck: true,
  },
  include: ["src/**/*.ts"],
});

test(
  "native TypeScript detects type errors and excluded source, without emitting incremental state",
  { timeout: 30_000 },
  async (t) => {
    const root = await fixture(t, {
      "package.json": "{}",
      "checktrail.json": policy("apps/example"),
      "apps/example/package.json": "{}",
      "apps/example/tsconfig.json": config,
      "apps/example/src/value with spaces.ts":
        "export const value: number = 42;\n",
    });
    await cp(compilerPackage, path.join(root, "node_modules/typescript"), {
      recursive: true,
    });
    const good = await validate(root, { trusted: true });
    assert.equal(good.outcome, "passed", JSON.stringify(good.checks));
    assert.equal(good.sourceChanged, false);
    assert.deepEqual(
      good.checks.map((check) => check.id),
      ["javascript.typescript"],
    );
    await assert.rejects(
      access(path.join(root, "apps/example/tsconfig.tsbuildinfo")),
    );
    await assert.rejects(
      access(path.join(root, "apps/example/src/value with spaces.js")),
    );
    await writeFile(
      path.join(root, "apps/example/src/value with spaces.ts"),
      'export const value: number = "incorrect";\n',
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.match(broken.checks[0]!.processes[0]!.stdout, /TS2322/);
    await writeFile(
      path.join(root, "apps/example/src/value with spaces.ts"),
      'export const value: string = "valid";\n',
    );
    await writeFile(
      path.join(root, "apps/example/excluded.ts"),
      'export const ignored: number = "incorrect";\n',
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(excluded.outcome, "incomplete");
    assert.match(excluded.checks[0]!.reason, /did not include every/);
  },
);

test("TypeScript planning never executes an installed compiler", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy(),
    "tsconfig.json": config,
    "src/value.ts": "export const value = 42;",
    "node_modules/typescript/bin/tsc":
      "require('node:fs').writeFileSync('executed', 'yes')",
  });
  const { plan } = await createPlan(root);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  await assert.rejects(access(path.join(root, "executed")));
});

test("TypeScript requires a local compiler and refuses one linked outside the root", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy(),
    "tsconfig.json": config,
    "src/value.ts": "export const value = 42;",
  });
  for (const linked of [false, true]) {
    if (linked) {
      await mkdir(path.join(root, "node_modules"));
      await symlink(
        compilerPackage,
        path.join(root, "node_modules/typescript"),
        "dir",
      );
    }
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "incomplete");
    assert.equal(report.checks[0]!.status, "unavailable");
    assert.equal(report.checks[0]!.processes.length, 0);
  }
});
