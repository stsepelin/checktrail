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
const legacyPackage = fileURLToPath(
  new URL(
    "../../.checktrail/typescript-legacy-tools/node_modules/typescript",
    import.meta.url,
  ),
);
const legacyAvailable = await access(
  path.join(legacyPackage, "package.json"),
).then(
  () => true,
  () => false,
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
    "node_modules/typescript/lib/typescript.js":
      "require('node:fs').writeFileSync('api-executed', 'yes')",
  });
  const { plan } = await createPlan(root);
  assert.equal(plan.checks[0]!.unavailableReason, undefined);
  await assert.rejects(access(path.join(root, "executed")));
  await assert.rejects(access(path.join(root, "api-executed")));
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

test(
  "native TypeScript 4.9 checks valid and broken source without newer flags or emitted files",
  {
    timeout: 30_000,
    skip: legacyAvailable ? false : "Prepared TypeScript 4.9.5 unavailable",
  },
  async (t) => {
    const root = await fixture(t, {
      "package.json": "{}",
      "checktrail.json": policy("packages/example"),
      "packages/example/package.json": "{}",
      "packages/example/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, types: [], incremental: true },
        include: ["src/**/*.ts"],
      }),
      "packages/example/src/value with spaces.ts":
        "export const value: number = 42;\n",
    });
    await cp(legacyPackage, path.join(root, "node_modules/typescript"), {
      recursive: true,
    });
    const passed = await validate(root, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(passed.sourceChanged, false);
    assert.equal(
      passed.checks[0]!.tools?.find((tool) => tool.name === "typescript")
        ?.version,
      "4.9.5",
    );
    for (const file of [
      "tsconfig.tsbuildinfo",
      "src/value with spaces.js",
      "src/value with spaces.d.ts",
    ]) {
      await assert.rejects(access(path.join(root, "packages/example", file)));
    }
    await writeFile(
      path.join(root, "packages/example/src/value with spaces.ts"),
      'export const value: number = "incorrect";\n',
    );
    const failed = await validate(root, { trusted: true });
    assert.equal(failed.outcome, "failed");
    assert.match(
      failed.checks[0]!.processes[0]!.stdout,
      /value with spaces\.ts\(1,14\): error TS2322:/,
    );
    assert.doesNotMatch(failed.checks[0]!.processes[0]!.stdout, /TS5023/);
    await writeFile(
      path.join(root, "packages/example/src/value with spaces.ts"),
      "export const value: number = 42;\n",
    );
    await writeFile(
      path.join(root, "packages/example/excluded.ts"),
      'export const excluded: number = "incorrect";\n',
    );
    const excluded = await validate(root, { trusted: true });
    assert.equal(excluded.checks[0]!.processes[0]!.exitCode, 0);
    assert.equal(excluded.outcome, "incomplete");
    assert.match(excluded.checks[0]!.reason, /did not include every/);
  },
);

test("TypeScript rejects an escaping compiler API before loading it", async (t) => {
  const outside = await fixture(t, {
    "typescript.js":
      "require('node:fs').writeFileSync('api-executed', 'yes');\n",
  });
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy(),
    "tsconfig.json": config,
    "src/value.ts": "export const value = 42;",
    "node_modules/typescript/package.json": JSON.stringify({
      name: "typescript",
      version: "6.0.3",
    }),
    "node_modules/typescript/bin/tsc":
      "require('node:fs').writeFileSync('cli-executed', 'yes');\n",
  });
  await mkdir(path.join(root, "node_modules/typescript/lib"));
  await symlink(
    path.join(outside, "typescript.js"),
    path.join(root, "node_modules/typescript/lib/typescript.js"),
  );
  const report = await validate(root, { trusted: true });
  assert.notEqual(report.outcome, "passed");
  assert.match(
    report.checks[0]!.processes[0]!.stderr,
    /Path escapes configured root/,
  );
  await assert.rejects(access(path.join(root, "api-executed")));
  await assert.rejects(access(path.join(root, "cli-executed")));
});

test("TypeScript rejects an ambiguous capability response before invoking its CLI", async (t) => {
  const root = await fixture(t, {
    "package.json": "{}",
    "checktrail.json": policy(),
    "tsconfig.json": config,
    "src/value.ts": "export const value = 42;",
    "node_modules/typescript/package.json": JSON.stringify({
      name: "typescript",
      version: "6.0.3",
    }),
    "node_modules/typescript/bin/tsc":
      "require('node:fs').writeFileSync('cli-executed', 'yes');\n",
    "node_modules/typescript/lib/typescript.js":
      "exports.parseCommandLine = () => ({options: {}, errors: [{code: 9999}], fileNames: []});\n",
  });
  const report = await validate(root, { trusted: true });
  assert.notEqual(report.outcome, "passed");
  assert.match(
    report.checks[0]!.processes[0]!.stderr,
    /Cannot establish the compiler's noCheck option support/,
  );
  await assert.rejects(access(path.join(root, "cli-executed")));
});
