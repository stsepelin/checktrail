import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { fixture } from "./helpers.js";

const script = fileURLToPath(
  new URL("../../scripts/check-ci-preflight.mjs", import.meta.url),
);
const { nativeJobIds, planNativeJobs, requireCiCompletion } = await import(
  new URL("../../scripts/ci-impact.mjs", import.meta.url).href
);
async function project(
  t: Parameters<typeof fixture>[0],
  version = "2.4.0",
  alias = false,
) {
  const name = alias ? "eslint-native-profile" : "fixture-driver",
    target = alias ? "eslint" : "fixture-driver";
  const declared = alias ? "npm:eslint@" + version : version;
  const manifest = {
    name: "synthetic-preflight",
    version: "1.0.0",
    dependencies: { [name]: declared },
    devDependencies: {},
  };
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        devDependencies: {},
      },
      ["node_modules/" + name]: {
        version,
        integrity: "sha512-c3ludGhldGlj",
        ...(alias ? { name: target } : {}),
      },
    },
  };
  const root = await fixture(t, {
    "package.json": JSON.stringify(manifest),
    "package-lock.json": JSON.stringify(lock),
    ["node_modules/" + name + "/package.json"]: JSON.stringify({
      name: target,
      version,
    }),
    ".github/workflows/ci.yml":
      "jobs:\n  delivery:\n    steps:\n      - run: node scripts/metadata.mjs\n",
    "scripts/metadata.mjs": "export const metadata = true;\n",
    "scripts/required-native-tests.json": "{}",
    "scripts/ci-native-inputs.json": JSON.stringify({
      "scripts/metadata.mjs": ["delivery"],
    }),
  });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return { root, manifest, lock, name, target };
}
const run = (root: string, args: string[] = [], ci = false) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, GITHUB_ACTIONS: ci ? "true" : "" },
  });

test("CI preflight follows exact dependency declarations across future versions and native aliases", async (t) => {
  for (const [version, alias] of [
    ["2.3.1", false],
    ["2.4.0", false],
    ["2.5.0", false],
    ["10.13.0", true],
  ] as const) {
    const f = await project(t, version, alias),
      result = run(f.root);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.declaredDependencyMetadataConsistent, true);
    assert.equal(report.inputContractCurrent, true);
    assert.equal(report.inputContractUpdated, false);
    assert.deepEqual(report.counts, { dependencies: 1, devDependencies: 0 });
  }
});

test("CI preflight refuses unpinned root selected installed and alias drift before admitting work", async (t) => {
  for (const change of [
    "range",
    "root",
    "selected",
    "installed-version",
    "installed-name",
    "integrity",
    "alias-target",
  ] as const) {
    const f = await project(t, "2.4.0", change === "alias-target");
    if (change === "range") {
      f.manifest.dependencies[f.name] = "^2.4.0";
      f.lock.packages[""].dependencies = f.manifest.dependencies;
      (
        f.lock.packages["node_modules/" + f.name] as { version: string }
      ).version = "^2.4.0";
      await writeFile(
        f.root + "/node_modules/" + f.name + "/package.json",
        JSON.stringify({ name: f.target, version: "^2.4.0" }),
      );
    }
    if (change === "root") f.lock.packages[""].dependencies = {};
    if (change === "selected")
      (
        f.lock.packages["node_modules/" + f.name] as { version: string }
      ).version = "2.5.0";
    if (change === "integrity")
      (
        f.lock.packages["node_modules/" + f.name] as { integrity: string }
      ).integrity = "";
    if (change === "alias-target")
      (f.lock.packages["node_modules/" + f.name] as { name: string }).name =
        "foreign";
    await writeFile(f.root + "/package.json", JSON.stringify(f.manifest));
    await writeFile(f.root + "/package-lock.json", JSON.stringify(f.lock));
    if (change.startsWith("installed"))
      await writeFile(
        f.root + "/node_modules/" + f.name + "/package.json",
        JSON.stringify({
          name: change === "installed-name" ? "foreign" : f.target,
          version: change === "installed-version" ? "2.5.0" : "2.4.0",
        }),
      );
    const result = run(f.root);
    assert.equal(result.status, 1, change + ":" + result.stdout);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CI preflight failed/);
  }
});

test("CI preflight rejects stale ownership and only the explicit local update can replace the reviewed contract", async (t) => {
  const f = await project(t);
  const before = await readFile(
    f.root + "/scripts/ci-native-inputs.json",
    "utf8",
  );
  await writeFile(
    f.root + "/scripts/metadata.mjs",
    "import './new-data.json' with {type:'json'};\n",
  );
  await writeFile(f.root + "/scripts/new-data.json", "{}");
  const stale = run(f.root);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /input contract is stale/);
  const refused = run(f.root, ["--update-inputs"], true);
  assert.equal(refused.status, 1);
  assert.equal(
    await readFile(f.root + "/scripts/ci-native-inputs.json", "utf8"),
    before,
  );
  const updated = run(f.root, ["--update-inputs"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).inputContractUpdated, true);
  assert.deepEqual(
    JSON.parse(
      await readFile(f.root + "/scripts/ci-native-inputs.json", "utf8"),
    ),
    {
      "scripts/metadata.mjs": ["delivery"],
      "scripts/new-data.json": ["delivery"],
    },
  );
  assert.equal(run(f.root).status, 0);
  assert.equal(run(f.root, ["--unknown"]).status, 1);
});

test("CI gates expensive jobs on successful cheap checks and cannot qualify a skipped matrix", async () => {
  const w = parse(
    await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const ids = nativeJobIds(w);
  const runs = w.jobs["ci-plan"].steps
    .filter((s: { run?: string }) => s.run)
    .map((s: { run: string }) => s.run);
  for (const command of [
    "node scripts/check-ci-preflight.mjs",
    "npm run typecheck",
    "npm run lint",
  ])
    assert.ok(
      runs.indexOf(command) > runs.indexOf("npm ci --ignore-scripts") &&
        runs.indexOf(command) < runs.indexOf("node scripts/plan-ci-impact.mjs"),
      command,
    );
  assert.equal(
    w.jobs.checks.if,
    "${{ always() && !cancelled() && needs.ci-plan.result == 'success' }}",
  );
  assert.equal(
    w.jobs["host-validation"].if,
    "${{ always() && !cancelled() && needs.ci-plan.result == 'success' && fromJSON(needs.ci-plan.outputs.plan).mode == 'full' }}",
  );
  for (const id of ids)
    assert.equal(
      w.jobs[id].if,
      "${{ always() && !cancelled() && needs.ci-plan.result == 'success' && fromJSON(needs.ci-plan.outputs.plan).selected['" +
        id +
        "'] }}",
    );
  assert.equal(w.jobs["ci-complete"].if, "${{ !cancelled() }}");
  const plan = planNativeJobs({
    jobs: ids,
    inputs: { "test/known.test.ts": ids },
    changed: ["unknown/input.ts"],
    eventName: "pull_request",
    contractCurrent: true,
  });
  assert.equal(plan.mode, "full");
  assert.ok(Object.values(plan.selected).every(Boolean));
  const needs = Object.fromEntries(
    ["ci-plan", "checks", "host-validation", ...ids].map((id) => [
      id,
      { result: "success" },
    ]),
  );
  assert.equal(requireCiCompletion(plan, needs).complete, true);
  needs["ci-plan"].result = "failure";
  assert.throws(
    () => requireCiCompletion(plan, needs),
    /CI outcome disagrees with selection: ci-plan/,
  );
  for (const id of ["checks", "host-validation", ...ids])
    needs[id].result = "skipped";
  assert.throws(
    () => requireCiCompletion(plan, needs),
    /CI outcome disagrees with selection:/,
  );
});
