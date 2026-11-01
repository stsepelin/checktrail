import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { fixture } from "./helpers.js";
const source = new URL(
    "../../scripts/consumer-native-job-claims.mjs",
    import.meta.url,
  ),
  api = await import(source.href);
test("early native job marker uses only Node built-ins and writes unique lane outputs with no executable lookup or unbuilt project import", async (t) => {
  const text = await readFile(source, "utf8"),
    syntax = ts.createSourceFile(
      "claims.mjs",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
  let imports = 0;
  function inspect(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      assert.ok(
        ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.startsWith("node:"),
      );
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      assert.ok(
        !["node:child_process", "node:module", "node:vm"].includes(
          node.moduleSpecifier.text,
        ),
      );
      imports++;
    }
    if (ts.isCallExpression(node))
      assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword);
    ts.forEachChild(node, inspect);
  }
  inspect(syntax);
  assert.ok(imports >= 6);
  const root = await fixture(t, {}),
    output = path.join(root, "output");
  await writeFile(output, "");
  const env = {
      ...process.env,
      PATH: "",
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "1234",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_JOB: "tasks-runtime",
      GITHUB_OUTPUT: output,
    },
    result = spawnSync(
      process.execPath,
      [fileURLToPath(source), "start", "windows-node22"],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
    );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = (await readFile(output, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.startsWith("claim="));
  assert.ok(lines[1]!.startsWith("native_start_windows_node22="));
  const claim = JSON.parse(lines[0]!.slice(6));
  assert.equal(claim.runAttempt, "2");
  assert.equal(claim.metadataAttested, false);
  assert.equal(claim.nativeExecutionInvoked, false);
  assert.equal(claim.gateAComplete, false);
  assert.equal(
    lines[1]!.slice(lines[1]!.indexOf("=") + 1),
    JSON.stringify(claim),
  );
  const prior = await readFile(output);
  const refused = spawnSync(
    process.execPath,
    [fileURLToPath(source), "start", "foreign-lane"],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(refused.status, 1);
  assert.deepEqual(await readFile(output), prior);
});
test("producer lane keys are finite and collision-free while wrong jobs slots paths and execution grants cannot create a marker", () => {
  const keys = new Set<string>();
  for (const lane of api.consumerNativeJobLanes("tasks-runtime")) {
    const pair = api.consumerNativeJobOutputKeys("tasks-runtime", lane);
    for (const value of Object.values(pair)) {
      assert.ok(typeof value === "string");
      assert.equal(keys.has(value), false);
      keys.add(value);
    }
  }
  assert.equal(keys.size, 14);
  for (const [job, lane] of [
    ["tasks-runtime", "windows_consumer_node22"],
    ["tasks-runtime", "../foreign"],
    ["php-context-arm64", "ci-linux-node22"],
    ["unknown", "single"],
  ])
    assert.throws(() => api.consumerNativeJobOutputKeys(job, lane));
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_JOB: "php-context-arm64",
  };
  for (const edit of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_RUN_ATTEMPT: "0" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_SHA: "foreign" },
  ])
    assert.throws(() =>
      api.createConsumerNativeJobStart({ ...env, ...edit }, "single"),
    );
});
