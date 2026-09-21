import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inventory, withinRoot } from "../src/inventory.js";
import { createPlan } from "../src/engine.js";
import { fixture, nodeManifest } from "./helpers.js";

test("discovers polyglot projects and nested package boundaries without executing manifests", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "client/package.json": nodeManifest,
    "client/widget.ts": "export const value = 1;",
    "pyproject.toml": '[project]\nname="example"',
    "setup.py": 'raise Exception("must never run")',
    "service/go.mod": "module example.test/service\ngo 1.22\n",
    "worker/composer.json": "{}",
    "rust/Cargo.toml": "[package]",
    "jvm/pom.xml": "<project/>",
    "dotnet/Demo.csproj": "<Project/>",
    "ruby/Gemfile": "",
    "swift/Package.swift": "",
    "native/CMakeLists.txt": "",
    "infra/main.tf": "",
    "node_modules/dependency/package.json": "{}",
    ".env": "SYNTHETIC_SECRET=never-output",
  });
  const { plan } = await createPlan(root);
  assert.equal(plan.projects.length, 12);
  assert.deepEqual(
    plan.projects.filter((p) => p.path === ".").map((p) => p.adapter),
    ["javascript", "python"],
  );
  assert.equal(
    plan.projects
      .find((p) => p.path === ".")
      ?.files.includes("client/widget.ts"),
    false,
  );
  assert.deepEqual(new Set(plan.excluded), new Set([".env", "node_modules"]));
  assert.match(
    plan.checks.find((check) => check.id === "rust.cargo-check")!
      .unavailableReason!,
    /No Rust source/,
  );
});

test("fingerprint changes for source contents and ignores excluded secrets", async (t) => {
  const root = await fixture(t, { "main.py": "one", ".env": "first" });
  const first = await inventory(root);
  await writeFile(path.join(root, ".env"), "second");
  assert.equal((await inventory(root)).fingerprint, first.fingerprint);
  await writeFile(path.join(root, "main.py"), "two");
  assert.notEqual((await inventory(root)).fingerprint, first.fingerprint);
});

test("rejects escaping paths and excludes symbolic links", async (t) => {
  const root = await fixture(t, { "main.py": "pass" });
  const outside = await fixture(t, { "secret.py": "private" });
  await symlink(outside, path.join(root, "linked"));
  const source = await inventory(root);
  assert.deepEqual(source.files, ["main.py"]);
  assert.deepEqual(source.excluded, ["linked"]);
  await assert.rejects(withinRoot(source.root, "linked/secret.py"), /escapes/);
  await assert.rejects(withinRoot(source.root, "../"), /escapes/);
  await assert.rejects(withinRoot(source.root, outside), /relative/);
});

test("rejects unknown configuration keys, check IDs, project paths and duplicate selections", async (t) => {
  const root = await fixture(t, { "package.json": nodeManifest });
  const cases = [
    {
      schemaVersion: 1,
      allowExecution: true,
      projects: [{ path: ".", checks: ["javascript.node-test"] }],
    },
    { schemaVersion: 1, projects: [{ path: ".", checks: ["shell.exec"] }] },
    {
      schemaVersion: 1,
      projects: [{ path: "../outside", checks: ["javascript.node-test"] }],
    },
    {
      schemaVersion: 1,
      projects: [
        { path: ".", checks: ["javascript.node-test", "javascript.node-test"] },
      ],
    },
    {
      schemaVersion: 1,
      projects: [
        { path: ".", checks: ["javascript.node-test"] },
        { path: ".", checks: ["javascript.node-test"] },
      ],
    },
  ];
  for (const value of cases) {
    await writeFile(
      path.join(root, "repo-verifier.json"),
      JSON.stringify(value),
    );
    await assert.rejects(createPlan(root));
  }
});

test("does not silently choose a runner for an unknown script", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"scripts":{"test":"vitest run"}}',
    "unit.test.js": "not a Node test",
  });
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /not explicitly selected/,
  );
});
