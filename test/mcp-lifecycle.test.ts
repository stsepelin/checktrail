import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fixture, nodeManifest } from "./helpers.js";
import { contractFixture } from "./contract-helpers.js";

async function waitForPid(
  root: string,
): Promise<{ pid: number; group: number }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return JSON.parse(
        await readFile(path.join(root, ".checktrail", "started.json"), "utf8"),
      ) as { pid: number; group: number };
    } catch {
      await delay(25);
    }
  }
  throw new Error("Synthetic long-running test did not start");
}

for (const shutdown of ["eof", "SIGTERM", "SIGINT"] as const) {
  test(
    `MCP ${shutdown} terminates an active contract worker`,
    { timeout: 10_000 },
    async (t) => {
      const input = contractFixture();
      input.contracts[0]!.schema = { type: "string", pattern: "^(a+)+$" };
      input.contracts[0]!.samples[0]!.payload = "a".repeat(1000) + "!";
      const root = await fixture(t, {
        "package.json": nodeManifest,
        "contract.json": JSON.stringify(input),
      });
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../src/cli.js", import.meta.url)),
          "serve",
          "--root",
          root,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      t.after(() => child.kill("SIGKILL"));
      const closed = once(child, "close", {
        signal: AbortSignal.timeout(5000),
      });
      void closed.catch(() => {});
      const ready = new Promise<void>((resolve) => {
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (JSON.parse(line).id === 1) resolve();
          }
        });
      });
      for (const [id, name, args] of [
        [
          0,
          "contract_validation",
          { input: "contract.json", timeoutMs: 30_000 },
        ],
        [1, "validation_plan", {}],
      ] as const)
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
              name,
              arguments: args,
            },
          }) + "\n",
        );
      await ready;
      if (shutdown === "eof") child.stdin.end();
      else child.kill(shutdown);
      await closed;
    },
  );
  test(
    `MCP ${shutdown} stops active validation and its child processes`,
    { timeout: 10_000 },
    async (t) => {
      const root = await fixture(t, {
        "package.json": nodeManifest,
        "slow.test.js": `import {test} from 'node:test';
import fs from 'node:fs';
test('waits for cancellation', async () => {
  fs.mkdirSync('.checktrail', {recursive:true});
  fs.writeFileSync('.checktrail/started.json', JSON.stringify({pid:process.pid,group:process.ppid}));
  await new Promise(resolve => setTimeout(resolve, 60000));
});`,
      });
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../src/cli.js", import.meta.url)),
          "serve",
          "--root",
          root,
          "--allow-execution",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const cleanup: { group?: number } = {};
      t.after(() => {
        child.kill("SIGKILL");
        if (cleanup.group) {
          try {
            process.kill(-cleanup.group, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
      });
      const closed = once(child, "close", {
        signal: AbortSignal.timeout(5000),
      });
      void closed.catch(() => {});
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
            name: "validation_run",
            arguments: { timeoutMs: 120_000 },
          },
        }) + "\n",
      );
      const started = await waitForPid(root);
      cleanup.group = started.group;
      if (shutdown === "eof") child.stdin.end();
      else child.kill(shutdown);
      await closed;
      let alive = true;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          process.kill(started.pid, 0);
        } catch {
          alive = false;
          break;
        }
        await delay(25);
      }
      assert.equal(alive, false, "Validation worker survived server shutdown");
    },
  );
}
