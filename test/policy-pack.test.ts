import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { loadPolicyPack, type PolicyPack } from "../src/policy-pack.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { copyESLint, eslintConfig } from "./eslint-helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import { adapters } from "../src/adapters.js";
import { policyPackSchema } from "../src/policy-pack.js";

const pack: PolicyPack = {
  schemaVersion: 1,
  id: "synthetic.core",
  version: "1.0.0",
  description: "Synthetic Node checks",
  requiredChecks: ["javascript.node-test"],
};
const encode = (value: unknown) => JSON.stringify(value);
const reference = (contents: string, file = "policy.json") => ({
  path: file,
  sha256: createHash("sha256").update(contents).digest("hex"),
});
const config = (
  checks: string[],
  packs: ReturnType<typeof reference>[] = [],
) => ({ schemaVersion: 1, projects: [{ path: ".", checks, packs }] });

test("pinned data-only packs require exact bytes and registered checks without executing project code", async (t) => {
  const contents = encode(pack);
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "value.test.js": passingTest,
    "policy.json": contents,
    "checktrail.json": encode(config([], [reference(contents)])),
  });
  const plan = (await createPlan(root)).plan;
  assert.deepEqual(
    plan.checks.map((check) => check.id),
    ["javascript.node-test"],
  );
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  await writeFile(path.join(root, "policy.json"), contents + "\n");
  await assert.rejects(createPlan(root), /integrity mismatch/);
  for (const invalid of [
    { ...pack, command: "touch should-not-exist" },
    { ...pack, extends: ["recursive.json"] },
    {
      ...pack,
      requiredChecks: ["javascript.node-test", "javascript.node-test"],
    },
    { ...pack, requiredChecks: [] },
    { ...pack, requiredChecks: ["javascript.unknown"] },
    { ...pack, requiredChecks: ["php.syntax"] },
    { ...pack, requiredEnvironment: ["NAME", "NAME"] },
    { ...pack, allowExecution: true },
  ]) {
    const value = encode(invalid);
    await writeFile(path.join(root, "policy.json"), value);
    await writeFile(
      path.join(root, "checktrail.json"),
      encode(config([], [reference(value)])),
    );
    await assert.rejects(createPlan(root));
  }
  await assert.rejects(access(path.join(root, "should-not-exist")));
  await assert.rejects(
    loadPolicyPack(root, reference(contents, "../outside.json")),
  );
  await assert.rejects(
    loadPolicyPack(root, reference(contents, path.join(root, "policy.json"))),
  );
  await writeFile(path.join(root, "policy.json"), " ".repeat(65 * 1024));
  await assert.rejects(
    loadPolicyPack(root, reference(" ".repeat(65 * 1024))),
    /64 KiB/,
  );
});

test("distributed public packs contain only registered requirements and unique identities", async () => {
  const directory = new URL("../../packs/", import.meta.url);
  const files = await readdir(directory);
  assert.ok(files.length > 0);
  const ids = new Set<string>();
  const checks = new Set<string>(
    adapters.flatMap((adapter) => [...adapter.checks]),
  );
  for (const name of files) {
    const value = policyPackSchema.parse(
      JSON.parse(await readFile(new URL(name, directory), "utf8")),
    );
    assert.ok(!ids.has(value.id));
    ids.add(value.id);
    for (const check of value.requiredChecks)
      assert.ok(checks.has(check), check);
    assert.equal(
      new Set(value.requiredChecks).size,
      value.requiredChecks.length,
    );
  }
});

test("packs and operator overlays add requirements without removing base checks or granting environment access", async (t) => {
  const contents = encode(pack);
  const overlay = config(["javascript.eslint"]);
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "value.test.js": passingTest,
    "value.js": "debugger;\n",
    "policy.json": contents,
    "checktrail.json": encode(config([], [reference(contents)])),
    "eslint.config.mjs": eslintConfig,
    ".checktrail.local.json": encode(overlay),
  });
  await copyESLint(root);
  const plain = await validate(root, { trusted: true });
  assert.equal(plain.outcome, "passed");
  const options = { trusted: true, policyOverlay: ".checktrail.local.json" };
  const report = await validate(root, options);
  assert.equal(report.outcome, "failed");
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.status]),
    [
      ["javascript.node-test", "passed"],
      ["javascript.eslint", "failed"],
    ],
  );
  assert.notEqual(report.policyFingerprint, plain.policyFingerprint);
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../src/cli.js", import.meta.url)),
      "run",
      "--root",
      root,
      "--policy-overlay",
      options.policyOverlay,
      "--trust-project",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.deepEqual(
    JSON.parse(cli.stdout).checks.map((check: { id: string }) => check.id),
    report.checks.map((check) => check.id),
  );
  assert.ok(!cli.stdout.includes(options.policyOverlay));
  const guarded = encode({ ...pack, requiredEnvironment: ["SYNTHETIC_MODE"] });
  await writeFile(path.join(root, "policy.json"), guarded);
  await writeFile(
    path.join(root, "checktrail.json"),
    encode(config([], [reference(guarded)])),
  );
  assert.equal(
    (await validate(root, { trusted: true })).checks[0]!.status,
    "unavailable",
  );
  assert.equal(
    (
      await validate(root, {
        trusted: true,
        environment: { SYNTHETIC_MODE: "test" },
      })
    ).outcome,
    "passed",
  );
});

test("conflicting packs, duplicate references, empty policies and workspace overrides are rejected", async (t) => {
  const contents = encode(pack);
  const alternate = encode({ ...pack, version: "2.0.0" });
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "value.test.js": passingTest,
    "policy.json": contents,
    "alternate.json": alternate,
  });
  for (const value of [
    config([]),
    config([], [reference(contents), reference(contents)]),
    {
      schemaVersion: 1,
      projects: [
        { path: ".", checks: ["javascript.node-test"] },
        { path: ".", checks: ["javascript.node-test"] },
      ],
    },
  ]) {
    await writeFile(path.join(root, "checktrail.json"), encode(value));
    await assert.rejects(createPlan(root));
  }
  await writeFile(
    path.join(root, "checktrail.json"),
    encode(config([], [reference(contents)])),
  );
  await writeFile(
    path.join(root, ".checktrail.local.json"),
    encode(config([], [reference(alternate, "alternate.json")])),
  );
  await assert.rejects(
    createPlan(root, { policyOverlay: ".checktrail.local.json" }),
    /Conflicting policy pack/,
  );
  for (const [name, value] of [
    [
      "checktrail.json",
      {
        ...config(["javascript.node-test"]),
        workspace: { complete: false, dependencies: [] },
      },
    ],
    [
      ".checktrail.local.json",
      {
        ...config(["javascript.node-test"]),
        workspace: { complete: true, dependencies: [] },
      },
    ],
  ] as const)
    await writeFile(path.join(root, name), encode(value));
  await assert.rejects(
    createPlan(root, { policyOverlay: ".checktrail.local.json" }),
    /Conflicting workspace/,
  );
});

test("hidden policy changes during execution invalidate otherwise passing evidence", async (t) => {
  for (const mode of ["overlay", "pack"] as const) {
    const contents = encode(pack);
    const hidden =
      mode === "overlay" ? ".checktrail.local.json" : ".checktrail/pack.json";
    const base =
      mode === "overlay"
        ? config(["javascript.node-test"])
        : config([], [reference(contents, hidden)]);
    const initial =
      mode === "overlay" ? encode(config(["javascript.node-test"])) : contents;
    const changed =
      mode === "overlay"
        ? encode(config(["javascript.node-test", "javascript.eslint"]))
        : contents + "\n";
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "checktrail.json": encode(base),
      [hidden]: initial,
      "change.test.js": `import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('changes hidden policy',()=>writeFileSync(${encode(hidden)},${encode(changed)}));`,
    });
    const report = await validate(root, {
      trusted: true,
      ...(mode === "overlay" ? { policyOverlay: hidden } : {}),
    });
    assert.equal(report.checks[0]!.status, "passed");
    assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
    assert.equal(report.outcome, "incomplete");
    assert.equal(
      mode === "overlay" ? report.sourceChanged : report.sourceError,
      true,
    );
  }
});

test("pack selection conservatively validates all projects when Git narrows source impact", async (t) => {
  const contents = encode(pack);
  const files = {
    "checktrail.json": encode({
      schemaVersion: 1,
      workspace: { complete: true, dependencies: [] },
      projects: ["first", "second"].map((name) => ({
        path: name,
        checks: [],
        packs: [reference(contents)],
      })),
    }),
    "policy.json": contents,
    "first/package.json": nodeManifest,
    "first/value.test.js": passingTest,
    "second/package.json": nodeManifest,
    "second/value.test.js": passingTest,
  };
  const root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet"]);
  const base = await syntheticCommit(root, files);
  await writeFile(path.join(root, "first/value.test.js"), passingTest + "\n");
  const plan = (await createPlan(root, { base })).plan;
  assert.equal(plan.selection!.mode, "full");
  assert.match(plan.selection!.reason, /Pack and operator-overlay/);
  assert.deepEqual(
    plan.checks.map((check) => check.project),
    ["first", "second"],
  );
});
