import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fixture, nodeManifest, passingTest } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import type { Report } from "../src/types.js";

export const consumerProjects = ["app", "lib", "other", "site"];
export const consumerDependencies = [
  { consumer: "app", producer: "lib" },
  { consumer: "site", producer: "lib" },
];
export const consumerPolicy = (mode = "fixed", note = "original") =>
  JSON.stringify({ mode, note });
export const consumerLibrary = `import {readFileSync} from 'node:fs';
const policy=JSON.parse(readFileSync(new URL('./policy.json',import.meta.url),'utf8'));
export function permits(value){return policy.mode==='prefix'?value.startsWith('grant'):value==='grant'||value.startsWith('grant:');}`;
export function consumerFiles(dependencies = consumerDependencies) {
  const files: Record<string, string> = {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      workspace: { complete: true, dependencies },
      projects: consumerProjects.map((path) => ({
        path,
        checks: ["javascript.node-test"],
      })),
    }),
    "lib/policy.json": consumerPolicy(),
    "lib/value.js": consumerLibrary,
    "lib/value.test.js":
      "import {test} from 'node:test';import assert from 'node:assert/strict';import{permits}from'./value.js';test('producer scoped grant',()=>assert.equal(permits('grant:read'),true));test('producer plain grant',()=>assert.equal(permits('grant'),true));",
    "other/value.test.js": passingTest,
  };
  for (const [project, token] of [
    ["app", "grantToken"],
    ["site", "grant2"],
  ])
    files[project + "/value.test.js"] =
      `import {test} from 'node:test';import assert from 'node:assert/strict';import{permits}from'../lib/value.js';test('${project} exact boundary',()=>assert.equal(permits('${token}'),false));test('${project} valid family',()=>assert.equal(permits('grant:read'),true));`;
  for (const project of consumerProjects) {
    files[project + "/package.json"] = nodeManifest;
    files[project + "/.checktrail/keep"] = "";
  }
  return files;
}
export async function consumerFixture(
  t: TestContext,
  dependencies = consumerDependencies,
) {
  const files = consumerFiles(dependencies),
    root = await fixture(t, files);
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(
    root,
    Object.fromEntries(
      Object.entries(files).filter(([name]) => !name.includes("/.checktrail/")),
    ),
  );
  return { root, base };
}
export async function changeConsumerPolicy(
  root: string,
  mode: string,
  note = "changed",
) {
  await writeFile(
    path.join(root, "lib/policy.json"),
    consumerPolicy(mode, note),
  );
}
export function assertConsumerExecution(
  report: Report,
  expected: "passed" | "failed",
  selected: string[],
) {
  assert.equal(report.outcome, expected);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.sourceError, false);
  assert.equal(report.sourceFingerprint, report.finalSourceFingerprint);
  assert.deepEqual(
    report.checks.map((c) => c.project),
    selected,
  );
  for (const check of report.checks) {
    const failed =
      expected === "failed" && ["app", "site"].includes(check.project);
    assert.equal(check.status, failed ? "failed" : "passed", check.project);
    assert.deepEqual(check.tests, {
      total: check.project === "other" ? 1 : 2,
      passed: check.project === "other" ? 1 : failed ? 1 : 2,
      failed: failed ? 1 : 0,
      skipped: 0,
    });
    assert.equal(check.processes.length, 1);
    const process = check.processes[0]!;
    assert.equal(process.cancelled, false);
    assert.equal(process.timedOut, false);
    assert.equal(process.truncated, false);
    assert.equal(process.errorCode, undefined);
    assert.equal(process.capturedOutput?.completeForObservedStreams, true);
    assert.equal(
      process.capturedOutput?.stdout.sha256,
      createHash("sha256").update(process.stdout).digest("hex"),
    );
    if (failed)
      assert.match(
        process.stdout,
        new RegExp(check.project + " exact boundary"),
      );
  }
}
export async function assertNoConsumerMarker(root: string) {
  await assert.rejects(readFile(path.join(root, "app/.checktrail/executed")), {
    code: "ENOENT",
  });
}
