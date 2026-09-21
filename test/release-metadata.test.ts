import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { VERSION } from "../src/types.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("registry metadata starts a root-scoped MCP server without granting execution or detailed output", async (t) => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const metadata = JSON.parse(
    await readFile(path.join(repository, "server.json"), "utf8"),
  );
  const npm = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(path.join(repository, "package-lock.json"), "utf8"),
  );
  assert.equal(metadata.name, npm.mcpName);
  assert.equal(metadata.version, VERSION);
  assert.equal(npm.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""].version, VERSION);
  assert.equal(metadata.packages.length, 1);
  const packaged = metadata.packages[0];
  assert.equal(packaged.registryType, "npm");
  assert.equal(packaged.identifier, npm.name);
  assert.equal(packaged.version, VERSION);
  assert.deepEqual(packaged.transport, { type: "stdio" });
  assert.equal(metadata.remotes, undefined);
  assert.equal(packaged.environmentVariables, undefined);
  const root = await fixture(t, {
    "package.json": nodeManifest,
    "example.test.js": passingTest,
  });
  const inputs = packaged.packageArguments;
  assert.equal(inputs[0].type, "positional");
  assert.equal(inputs[0].value, "serve");
  assert.equal(inputs[1].type, "named");
  assert.equal(inputs[1].name, "--root");
  assert.equal(inputs[1].variables.project_root.isRequired, true);
  const args = inputs.flatMap(
    (input: { type: string; name?: string; value: string }) =>
      input.type === "named"
        ? [input.name!, input.value.replace("{project_root}", root)]
        : [input.value],
  );
  const client = new Client(
    { name: "synthetic-registry-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repository, npm.bin["repo-verifier"]), ...args],
      stderr: "pipe",
    }),
  );
  const plan = await client.callTool({
    name: "validation_plan",
    arguments: {},
  });
  assert.equal(plan.isError, undefined);
  assert.ok(JSON.stringify(plan).includes("javascript.node-test"));
  assert.ok(!JSON.stringify(plan).includes(root));
  const execution = await client.callTool({
    name: "validation_run",
    arguments: {},
  });
  assert.equal(execution.isError, true);
  assert.match(JSON.stringify(execution), /Execution is disabled/);
});
