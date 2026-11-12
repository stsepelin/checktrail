import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createPlan } from "../src/engine.js";
import { randomReleaseProofEnvironment as key } from "../src/terraform-release-signature.js";
import { terraformExtensionsFiles } from "./terraform-extensions-fixture.js";
import { fixture } from "./helpers.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("Random release proof authority is captured from operator environment and blanked when absent", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles()),
    previous = process.env[key];
  try {
    delete process.env[key];
    const legacy = (await createPlan(root)).plan.checks[0]!;
    assert.equal(legacy.commands[0]!.env![key], "");
    process.env[key] = "a".repeat(64);
    const selected = (await createPlan(root)).plan.checks[0]!;
    assert.equal(selected.commands[0]!.env![key], "a".repeat(64));
    process.env[key] = "b".repeat(64);
    assert.equal(selected.commands[0]!.env![key], "a".repeat(64));
    for (const value of [" ", "not-a-pin", "A".repeat(64), "a".repeat(63)]) {
      process.env[key] = value;
      const bad = (await createPlan(root)).plan.checks[0]!;
      assert.ok(bad.unavailableReason);
      assert.deepEqual(bad.commands, []);
    }
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("Random project/request environment cannot grant or replace release proof authority", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles()),
    previous = process.env[key];
  try {
    delete process.env[key];
    const ignored = await createPlan(root, {
      environment: { [key]: "a".repeat(64) },
    });
    assert.equal(ignored.plan.checks[0]!.commands[0]!.env![key], "");
    await writeFile(
      path.join(root, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: ".",
            checks: ["infrastructure.terraform-extensions"],
            environment: [key],
          },
        ],
      }),
    );
    await assert.rejects(
      createPlan(root, { environment: { [key]: "a".repeat(64) } }),
      /protected adapter settings/u,
    );
    // Even an externally supplied unknown/malformed value cannot silently become legacy.
    await assert.rejects(
      createPlan(root, { environment: { [key]: "not-a-proof" } }),
      /protected adapter settings/u,
    );
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("Random release proof CLI and actual MCP plans share startup authority and reject per-request promotion", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles());
  for (const selected of ["", "a".repeat(64)]) {
    const env = {
      ...process.env,
      [key]: selected,
      NODE_OPTIONS: "",
      NODE_PATH: "",
    };
    const output = await exec(
      process.execPath,
      [cli, "plan", "--root", root, "--detailed"],
      { env },
    );
    const plan = JSON.parse(output.stdout) as {
      checks: { commands: { env: Record<string, string> }[] }[];
    };
    assert.equal(plan.checks[0]!.commands[0]!.env[key], selected);
    const client = new Client(
      { name: "synthetic-proof-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "serve", "--root", root, "--detailed"],
      env: {
        PATH: process.env.PATH ?? "",
        [key]: selected,
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "validation_plan",
        arguments: {},
      });
      assert.equal(response.isError, undefined);
      const mcp = response.structuredContent as typeof plan;
      assert.equal(mcp.checks[0]!.commands[0]!.env[key], selected);
      const refused = await client
        .callTool({
          name: "validation_plan",
          arguments: { environment: { [key]: "b".repeat(64) } },
        })
        .catch(() => ({ isError: true }));
      assert.equal(refused.isError, true);
      const after = await client.callTool({
        name: "validation_plan",
        arguments: {},
      });
      assert.equal(
        (after.structuredContent as typeof plan).checks[0]!.commands[0]!.env[
          key
        ],
        selected,
      );
    } finally {
      await client.close();
    }
  }
});

test("Random release proof summary planning exposes no operator cache or native verification witness", async (t) => {
  const root = await fixture(t, terraformExtensionsFiles());
  const output = await exec(process.execPath, [cli, "plan", "--root", root], {
    env: { ...process.env, [key]: "a".repeat(64) },
  });
  assert.ok(!output.stdout.includes(root));
  assert.ok(!output.stdout.includes("GNUPG"));
  assert.ok(!output.stdout.includes("provider-public-key.asc"));
  assert.ok(!output.stdout.includes("terraform-extensions-signed-tools"));
});
