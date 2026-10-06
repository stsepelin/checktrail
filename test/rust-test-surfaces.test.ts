import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import { reportSchema } from "../src/schemas.js";
const available = /^rustdoc 1\.98\.1 /.test(
  spawnSync("rustdoc", ["--version"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
  }).stdout ?? "",
);
const files = () => ({
  "Cargo.toml":
    '[package]\nname="synthetic_tests"\nversion="0.1.0"\nedition="2024"\n',
  "Cargo.lock":
    'version=4\n[[package]]\nname="synthetic_tests"\nversion="0.1.0"\n',
  "checktrail.json": JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: ".", checks: ["rust.cargo-test"] }],
  }),
  "src/lib.rs":
    "pub fn sum(a:i32,b:i32)->i32 { a-b }\n#[cfg(test)] mod tests { #[test] fn addition() { assert_eq!(super::sum(2,3),5); } }\n",
});
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function connect(root: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [cli, "serve", "--root", root, ...args],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  let stopped = false;
  let sequence = 0;
  let stderr = "";
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  child.stderr.on("data", (b) => {
    stderr = (stderr + String(b)).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  child.on("exit", () => {
    stopped = true;
    for (const entry of pending.values())
      entry.reject(new Error(`Server exited: ${stderr}`));
    pending.clear();
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.id === "number") {
      pending.get(value.id)?.resolve(value);
      pending.delete(value.id);
    }
  });
  return {
    async request(name: string, arguments_: Record<string, unknown> = {}) {
      const id = sequence++;
      const timer = setTimeout(() => {
        pending.get(id)?.reject(new Error(`Tool timeout: ${stderr}`));
        pending.delete(id);
      }, 30000);
      try {
        const result = await new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name,
                  arguments: arguments_,
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }) + "\n",
            );
          },
        );
        assert.equal(result.error, undefined);
        return result.result as {
          isError?: boolean;
          structuredContent?: unknown;
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (!stopped) child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
    },
  };
}
test(
  "Rust test CLI and MCP agree on native assertion failures retain counts preserve summary privacy and reject argument trust injection",
  {
    skip: available ? false : "Pinned native Rust test toolchain unavailable",
    timeout: 90000,
  },
  async (t) => {
    const root = await fixture(t, files());

    const output = spawnSync(
      process.execPath,
      [cli, "run", "--root", root, "--trust-project", "--detailed"],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(output.status, 1, output.stderr);
    const report = reportSchema.parse(JSON.parse(output.stdout));
    assert.equal(report.outcome, "failed");
    assert.equal(report.sourceChanged, false);
    assert.deepEqual(report.checks[0]!.tests, {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
    assert.equal(report.checks[0]!.findingsComplete, true);
    const server = await connect(root, ["--allow-execution"], process.env);
    try {
      const result = await server.request("validation_run");
      assert.notEqual(result.isError, true);
      const summary = result.structuredContent as {
        outcome: string;
        checks: { id: string; status: string }[];
      };
      assert.equal(summary.outcome, "failed");
      assert.equal(summary.checks[0]!.id, "rust.cargo-test");
      assert.equal(summary.checks[0]!.status, report.checks[0]!.status);
      assert.ok(
        !JSON.stringify(result).includes(root) &&
          !JSON.stringify(result).includes("src/lib.rs"),
      );
      assert.equal(
        (await server.request("validation_run", { trusted: true })).isError,
        true,
      );
    } finally {
      await server.close();
    }
    const denied = await connect(root, [], process.env);
    try {
      assert.equal((await denied.request("validation_run")).isError, true);
    } finally {
      await denied.close();
    }
  },
);
