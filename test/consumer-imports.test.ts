import assert from "node:assert/strict";
import { writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { reconcileConsumerImports } from "../src/consumer-imports.js";
import { inventory } from "../src/inventory.js";
import { createPlan, validate } from "../src/engine.js";
import { projectPlan } from "../src/output.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";

const projects = ["app", "lib", "other"];
const workspace = {
  complete: true,
  dependencies: [{ consumer: "app", producer: "lib" }],
};
function sources(dependencies = workspace.dependencies) {
  return {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      workspace: { ...workspace, dependencies },
      projects: projects.map((path) => ({
        path,
        checks: ["javascript.node-test"],
      })),
    }),
    "app/package.json": nodeManifest,
    "app/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../lib/value.js'; test('consumer contract',()=>assert.equal(value,1));",
    "lib/package.json": nodeManifest,
    "lib/value.test.js": passingTest,
    "lib/value.js": "export const value = 1;\n",
    "other/package.json": nodeManifest,
    "other/value.test.js": passingTest,
  };
}

test("captured imports expose an undeclared consumer and full validation retains its native failure", async (t) => {
  const files = sources([]);
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "lib/value.js"), "export const value = 2;\n");
  const evidence = await reconcileConsumerImports(
    await inventory(root),
    projects,
    { complete: true, dependencies: [] },
  );
  assert.equal(evidence.status, "inconsistent");
  assert.deepEqual(evidence.edges, workspace.dependencies);
  const full = await createPlan(root);
  const selected = await createPlan(root, { base });
  assert.equal(selected.plan.selection?.mode, "full");
  assert.match(
    selected.plan.selection!.reason,
    /omit a captured source consumer/,
  );
  assert.deepEqual(selected.plan.checks, full.plan.checks);
  const report = await validate(root, { trusted: true, base });
  assert.equal(report.outcome, "failed");
  assert.deepEqual(
    report.checks.map((c) => [c.project, c.status]),
    [
      ["app", "failed"],
      ["lib", "passed"],
      ["other", "passed"],
    ],
  );
  assert.match(report.checks[0]!.processes[0]!.stdout, /2 !== 1/);
  await writeFile(
    path.join(root, "lib/value.js"),
    "export const value = 1 + 0;\n",
  );
  const fixed = await validate(root, { trusted: true, base });
  assert.equal(fixed.outcome, "passed");
  assert.equal(fixed.selection?.mode, "full");
  assert.ok(
    fixed.checks.every((c) => c.tests?.total === 1 && c.tests.passed === 1),
  );
});

test("a declared transitive graph retains affected consumers and omits the independent project", async (t) => {
  const files = sources();
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "lib/value.js"), "export const value = 2;\n");
  const evidence = await reconcileConsumerImports(
    await inventory(root),
    projects,
    workspace,
  );
  assert.equal(evidence.status, "resolved");
  assert.deepEqual(evidence.edges, workspace.dependencies);
  const selected = await createPlan(root, { base });
  assert.equal(selected.plan.selection?.mode, "affected");
  assert.deepEqual(
    selected.plan.checks.map((c) => c.project),
    ["app", "lib"],
  );
  assert.equal((await createPlan(root)).plan.checks.length, 3);
  const summary = JSON.stringify(projectPlan(selected.plan, false));
  assert.ok(!summary.includes("lib/value.js"));
  assert.ok(!summary.includes(root));
});

test("captured file edges follow reexports and unowned bridges without treating a project prefix as ownership", async (t) => {
  const root = await fixture(t, {
    ...sources(),
    "app/value.test.js":
      "import {value} from '../shared/bridge.js'; export {value};",
    "shared/bridge.js": "export {value} from '../lib/value.js';",
    "library/lookalike.js": "export const value=9;",
    "other/value.test.js":
      "import {value} from '../library/lookalike.js'; export {value};",
  });
  const source = await inventory(root);
  assert.deepEqual(
    (await reconcileConsumerImports(source, projects, workspace)).edges,
    workspace.dependencies,
  );
  const chain = {
    complete: true,
    dependencies: [
      { consumer: "app", producer: "other" },
      { consumer: "other", producer: "lib" },
    ],
  };
  assert.equal(
    (await reconcileConsumerImports(source, projects, chain)).status,
    "resolved",
  );
  const cycle = {
    complete: true,
    dependencies: [
      ...workspace.dependencies,
      { consumer: "lib", producer: "app" },
    ],
  };
  assert.equal(
    (await reconcileConsumerImports(source, projects, cycle)).status,
    "resolved",
  );
});

test("literal shared JSON reads reconcile the physical producer for named synchronous and asynchronous readers", async (t) => {
  for (const [module, reader] of [
    ["node:fs", "readFileSync"],
    ["node:fs/promises", "readFile"],
  ]) {
    const root = await fixture(t, {
      ...sources([]),
      "app/value.test.js": `import {${reader} as load} from '${module}'; const value=load(new URL('../lib/contract.json', import.meta.url),'utf8'); export {value};`,
      "lib/contract.json": '{"version":1,"value":1}',
    });
    const source = await inventory(root);
    const bad = await reconcileConsumerImports(source, projects, {
      complete: true,
      dependencies: [],
    });
    assert.equal(bad.status, "inconsistent");
    assert.deepEqual(bad.edges, workspace.dependencies);
    assert.equal(
      (await reconcileConsumerImports(source, projects, workspace)).status,
      "resolved",
    );
  }
});

const unknownSources: Record<string, string> = {
  "dynamic-import":
    "const name='../lib/value.js'; export const value=import(name);",
  "require-alias":
    "const load=require; export const value=load('../lib/value.js');",
  "shadow-require":
    "function require(x){return x}; require('../lib/value.js');",
  "computed-loader": "globalThis['require']('../lib/value.js');",
  "reflected-loader":
    "Reflect.get(()=>{},'constructor')('return import(\"../lib/value.js\")')();",
  "create-require":
    "import {createRequire} from 'node:module'; createRequire(import.meta.url)('../lib/value.js');",
  "native-worker":
    "import {Worker} from 'node:worker_threads'; new Worker('../lib/value.js');",
  "unselected-builtin":
    "import inspector from 'node:inspector'; export {inspector};",
  "mandatory-builtin-prefix": "import value from 'test'; export {value};",
  "builtin-prefix": "import value from 'node:fsToken'; export {value};",
  "bare-package": "import {value} from 'local-library'; export {value};",
  "package-alias": "import {value} from '#library'; export {value};",
  extensionless: "export {value} from '../lib/value';",
  escaping: "export {value} from '../../outside.js';",
  "encoded-path": "export {value} from '../lib/%76alue.js';",
  "query-path": "export {value} from '../lib/value.js?other';",
  "missing-path": "export {value} from '../lib/missing.js';",
  "namespace-fs":
    "import * as fs from 'node:fs'; fs.readFileSync('../lib/contract.json');",
  "fs-loader-require":
    "const fs=require('node:fs'); fs.readFileSync('../lib/contract.json');",
  "reader-alias":
    "import {readFileSync} from 'node:fs'; const load=readFileSync; load(new URL('../lib/contract.json',import.meta.url));",
  "shadow-reader":
    "import {readFileSync} from 'node:fs'; function f({readFileSync}){return readFileSync(new URL('../lib/contract.json',import.meta.url))}; export {f};",
  "shadow-url":
    "import {readFileSync} from 'node:fs'; function f({URL}){return readFileSync(new URL('../lib/contract.json',import.meta.url))}; export {f};",
  "indirect-url":
    "import {readFileSync} from 'node:fs'; const u=new URL('../lib/contract.json',import.meta.url); readFileSync(u);",
  "dynamic-resource":
    "import {readFileSync} from 'node:fs'; const name='../lib/contract.json'; readFileSync(new URL(name,import.meta.url));",
  "mutated-url": "URL=function(){};",
  "broken-syntax": "export {value from '../lib/value.js';",
  "compiler-reference":
    '/// <reference path="../lib/types.d.ts" />\nexport const value=1;',
};
test("unknown source and resource families retain the full shared engine plan", async (t) => {
  for (const [name, text] of Object.entries(unknownSources))
    await t.test(name, async (t) => {
      const files = {
        ...sources(),
        "app/value.test.js": text,
        "lib/contract.json": '{"value":1}',
      };
      const root = await fixture(t, files);
      fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
      const base = await syntheticCommit(root, files);
      await writeFile(
        path.join(root, "lib/value.js"),
        "export const value=2;\n",
      );
      const evidence = await reconcileConsumerImports(
        await inventory(root),
        projects,
        workspace,
      );
      assert.equal(evidence.status, "unknown", name);
      assert.deepEqual(evidence.edges, []);
      const selected = await createPlan(root, { base });
      assert.equal(selected.plan.selection?.mode, "full", name);
      assert.deepEqual(
        selected.plan.checks.map((c) => c.project),
        projects,
      );
    });
});

test("literal dynamic imports and CommonJS exact imports expose a missing graph without executing source", async (t) => {
  for (const text of [
    "export const value=import('../lib/value.js');",
    "const value=require('../lib/value.js'); exports.value=value;",
  ]) {
    const root = await fixture(t, { ...sources(), "app/value.test.js": text });
    assert.equal(
      (
        await reconcileConsumerImports(await inventory(root), projects, {
          complete: true,
          dependencies: [],
        })
      ).status,
      "inconsistent",
    );
  }
  const root = await fixture(t, {
    ...sources(),
    "app/value.test.js":
      "import {writeFileSync} from 'node:fs'; writeFileSync('executed','bad');",
  });
  assert.equal(
    (await reconcileConsumerImports(await inventory(root), projects, workspace))
      .status,
    "unknown",
  );
  await assert.rejects(readFile(path.join(root, "executed")), {
    code: "ENOENT",
  });
});

test("stale, excluded, empty, unsupported and exhausted import observations stay unknown", async (t) => {
  const root = await fixture(t, sources());
  const source = await inventory(root);
  await writeFile(path.join(root, "lib/value.js"), "export const value=2;\n");
  assert.equal(
    (await reconcileConsumerImports(source, projects, workspace)).status,
    "unknown",
  );
  const empty = await fixture(t, { "empty.json": "{}" });
  assert.equal(
    (
      await reconcileConsumerImports(
        await inventory(empty),
        projects,
        workspace,
      )
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await reconcileConsumerImports(await inventory(root), projects, {
        ...workspace,
        complete: false,
      })
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await reconcileConsumerImports(
        await inventory(root),
        [".", ...projects],
        workspace,
      )
    ).status,
    "unknown",
  );
  for (const file of [
    "app/value.ts",
    "app/value.py",
    "app/value.php",
    "app/tsconfig.json",
  ]) {
    const unsupported = await fixture(t, { ...sources(), [file]: "" });
    assert.equal(
      (
        await reconcileConsumerImports(
          await inventory(unsupported),
          projects,
          workspace,
        )
      ).status,
      "unknown",
      file,
    );
  }
  const excluded = await fixture(t, {
    ...sources(),
    "app/value.test.js": "export {value} from './linked.js';",
  });
  await symlink(
    path.join(excluded, "lib/value.js"),
    path.join(excluded, "app/linked.js"),
  );
  assert.equal(
    (
      await reconcileConsumerImports(
        await inventory(excluded),
        projects,
        workspace,
      )
    ).status,
    "unknown",
  );
  const invalid = await fixture(t, sources());
  await writeFile(
    path.join(invalid, "app/value.test.js"),
    Buffer.from([0xff, 0xfe]),
  );
  assert.equal(
    (
      await reconcileConsumerImports(
        await inventory(invalid),
        projects,
        workspace,
      )
    ).status,
    "unknown",
  );
  const large = await fixture(t, {
    ...sources(),
    "app/large.js": "//" + "x".repeat(4 * 1048576),
  });
  assert.equal(
    (
      await reconcileConsumerImports(
        await inventory(large),
        projects,
        workspace,
      )
    ).status,
    "unknown",
  );
  const many = await fixture(t, sources());
  await mkdir(path.join(many, "app/generated"));
  for (let n = 0; n < 513; n++)
    await writeFile(
      path.join(many, `app/generated/${n}.js`),
      "export const n=1;",
    );
  assert.equal(
    (await reconcileConsumerImports(await inventory(many), projects, workspace))
      .status,
    "unknown",
  );
});

test("CommonJS module loaders retain full validation and its actual consumer assertion failure", async (t) => {
  const manifest = JSON.stringify({
    private: true,
    type: "commonjs",
    scripts: { test: "node --test" },
  });
  const files = {
    "checktrail.json": sources([])["checktrail.json"],
    "app/package.json": manifest,
    "app/value.test.cjs":
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); module.load(require('node:path').join(__dirname,'../lib/value.cjs')); test('module consumer contract',()=>assert.equal(module.exports.value,1));",
    "lib/package.json": manifest,
    "lib/value.cjs": "exports.value=1;\n",
    "lib/value.test.cjs":
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); const {value}=require('./value.cjs'); test('producer numeric contract',()=>assert.equal(typeof value,'number'));",
    "other/package.json": manifest,
    "other/value.test.cjs":
      "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('independent contract',()=>assert.equal(2+3,5));",
  };
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  const baseline = await validate(root, { trusted: true });
  assert.equal(
    baseline.outcome,
    "passed",
    JSON.stringify(
      baseline.checks.map((c) => ({
        status: c.status,
        reason: c.reason,
        stderr: c.processes.map((p) => p.stderr),
      })),
    ),
  );
  assert.ok(
    baseline.checks.every((c) => c.tests?.total === 1 && c.tests.passed === 1),
  );
  await writeFile(path.join(root, "lib/value.cjs"), "exports.value=2;\n");
  const full = await validate(root, { trusted: true });
  assert.equal(full.outcome, "failed");
  assert.deepEqual(
    full.checks.map((c) => [c.project, c.status]),
    [
      ["app", "failed"],
      ["lib", "passed"],
      ["other", "passed"],
    ],
  );
  assert.match(full.checks[0]!.processes[0]!.stdout, /2 !== 1/);
  const selected = await validate(root, { trusted: true, base });
  assert.equal(selected.selection?.mode, "full");
  assert.equal(selected.outcome, "failed");
  assert.deepEqual(
    selected.checks.map((c) => [c.project, c.status]),
    full.checks.map((c) => [c.project, c.status]),
  );
  await writeFile(path.join(root, "lib/value.cjs"), "exports.value=1+0;\n");
  const repaired = await validate(root, { trusted: true, base });
  assert.equal(repaired.outcome, "passed");
  assert.equal(repaired.selection?.mode, "full");
});
