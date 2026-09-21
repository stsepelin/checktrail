import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan, validate } from "../src/engine.js";
import {
  environmentFingerprint,
  inheritEnvironment,
  operatorEnvironment,
} from "../src/environment.js";
import { projectReport } from "../src/output.js";
import { reportSchema } from "../src/schemas.js";
import { fixture, nodeManifest } from "./helpers.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [
    {
      path: ".",
      checks: ["javascript.node-test"],
      environment: ["VERIFIER_TEST_MODE"],
    },
  ],
});
const source =
  "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('environment',()=>{ assert.equal(process.env.VERIFIER_TEST_MODE, 'synthetic-value'); assert.equal(process.env.UNREQUESTED_VALUE, undefined); });";

test("project environment needs operator permission, is scoped to requests and recorded without values", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "checktrail.json": policy,
    "env.test.js": source,
  });
  const unavailable = await validate(root, { trusted: true });
  assert.equal(unavailable.outcome, "incomplete");
  assert.equal(unavailable.checks[0]!.status, "unavailable");
  assert.deepEqual(unavailable.checks[0]!.processes, []);
  const environment = {
    VERIFIER_TEST_MODE: "synthetic-value",
    UNREQUESTED_VALUE: "must-not-arrive",
  };
  const plan = await createPlan(root, { environment });
  assert.equal(plan.plan.checks[0]!.unavailableReason, undefined);
  assert.deepEqual(plan.plan.checks[0]!.environment, ["VERIFIER_TEST_MODE"]);
  assert.ok(!JSON.stringify(plan.plan).includes("synthetic-value"));
  const report = await validate(root, { trusted: true, environment });
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  reportSchema.parse(report);
  assert.deepEqual(report.checks[0]!.environment, {
    names: ["VERIFIER_TEST_MODE"],
    fingerprint: environmentFingerprint({
      VERIFIER_TEST_MODE: "synthetic-value",
    }),
  });
  assert.ok(!JSON.stringify(report).includes("synthetic-value"));
  assert.ok(!JSON.stringify(report).includes("must-not-arrive"));
  assert.ok(
    !JSON.stringify(projectReport(report, false)).includes(
      "VERIFIER_TEST_MODE",
    ),
  );
  assert.notEqual(
    report.checks[0]!.environment!.fingerprint,
    environmentFingerprint({ VERIFIER_TEST_MODE: "changed" }),
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["javascript.node-test"] }],
    }),
  );
  await writeFile(
    path.join(root, "env.test.js"),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('unrequested',()=>assert.equal(process.env.VERIFIER_TEST_MODE, undefined));",
  );
  assert.equal(
    (await validate(root, { trusted: true, environment })).outcome,
    "passed",
  );
});

test("environment permissions reject unset, duplicate and malformed names and cannot override adapter safeguards", async (t) => {
  assert.throws(() => inheritEnvironment(["MISSING"], {}), /unset/);
  assert.throws(
    () => inheritEnvironment(["MODE", "MODE"], { MODE: "test" }),
    /Duplicate/,
  );
  assert.deepEqual(inheritEnvironment(["MODE"], { MODE: "" }), { MODE: "" });
  for (const value of [
    { "INVALID=KEY": "x" },
    { MODE: "contains\0nul" },
    { MODE: "x".repeat(16_385) },
  ])
    assert.throws(() => operatorEnvironment(value));
  const root = await fixture(t, {
    "go.mod": "module example.invalid/synthetic\n\ngo 1.26\n",
    "value.go": "package synthetic\n",
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["go.test"], environment: ["GOPROXY"] }],
    }),
  });
  await assert.rejects(
    createPlan(root, { environment: { GOPROXY: "public" } }),
    /protected adapter/,
  );
  await writeFile(
    path.join(root, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: ".", checks: ["go.test"], environment: ["MODE", "MODE"] },
      ],
    }),
  );
  await assert.rejects(createPlan(root), /Duplicate environment/);
  assert.equal(
    environmentFingerprint({ A: "1", B: "2" }),
    environmentFingerprint({ B: "2", A: "1" }),
  );
});

test("CLI and MCP use startup environment permissions and tool arguments cannot supply values", async (t) => {
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "checktrail.json": policy,
    "env.test.js": source,
  });
  const env = { ...process.env, VERIFIER_TEST_MODE: "synthetic-value" };
  const denied = spawnSync(
    process.execPath,
    [cli, "run", "--root", root, "--trust-project"],
    { env, encoding: "utf8" },
  );
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).checks[0].status, "unavailable");
  const allowed = spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--root",
      root,
      "--trust-project",
      "--allow-env",
      "VERIFIER_TEST_MODE",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  for (const permissions of [[], ["--allow-env", "VERIFIER_TEST_MODE"]]) {
    const client = new Client(
      { name: "environment-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            cli,
            "serve",
            "--root",
            root,
            "--allow-execution",
            ...permissions,
          ],
          env: { VERIFIER_TEST_MODE: "synthetic-value" },
          stderr: "pipe",
        }),
      );
      const injection = await client.callTool({
        name: "validation_run",
        arguments: { environment: { VERIFIER_TEST_MODE: "synthetic-value" } },
      });
      assert.equal(injection.isError, true);
      const result = await client.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.equal(
        (result.structuredContent as { outcome: string }).outcome,
        permissions.length ? "passed" : "incomplete",
      );
      assert.ok(!JSON.stringify(result).includes("synthetic-value"));
    } finally {
      await client.close();
    }
  }
});

test("workspace projects receive only their own requested environment and library calls snapshot values", async (t) => {
  const root = await fixture(t, {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: "one",
          checks: ["javascript.node-test"],
          environment: ["ONE_MODE"],
        },
        {
          path: "two",
          checks: ["javascript.node-test"],
          environment: ["TWO_MODE"],
        },
      ],
    }),
    "one/package.json": nodeManifest,
    "two/package.json": nodeManifest,
    "one/env.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('one',()=>{assert.equal(process.env.ONE_MODE,'one');assert.equal(process.env.TWO_MODE,undefined);});",
    "two/env.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('two',()=>{assert.equal(process.env.TWO_MODE,'two');assert.equal(process.env.ONE_MODE,undefined);});",
  });
  const environment = { ONE_MODE: "one", TWO_MODE: "two" };
  const running = validate(root, { trusted: true, environment });
  environment.ONE_MODE = "mutated-after-invocation";
  const report = await running;
  assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
  assert.deepEqual(
    report.checks.map((check) => check.environment?.names),
    [["ONE_MODE"], ["TWO_MODE"]],
  );
  assert.notEqual(
    report.checks[0]!.environment!.fingerprint,
    report.checks[1]!.environment!.fingerprint,
  );
});
