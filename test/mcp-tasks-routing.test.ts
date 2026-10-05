import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("published official SDK routes standard Tasks get cancel and update without transport interception", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const lock = JSON.parse(
    await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
  );
  for (const name of ["server", "client", "core"]) {
    const installed = JSON.parse(
      await readFile(
        new URL(
          `../../node_modules/@modelcontextprotocol/${name}/package.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(installed.version, "2.3.0");
    assert.equal(
      lock.packages[`node_modules/@modelcontextprotocol/${name}`].version,
      installed.version,
    );
  }
  const probe = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/probe-mcp-tasks.mjs", import.meta.url),
      ),
    ],
    { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(probe.status, 0, probe.stderr + probe.stdout);
  assert.equal(probe.signal, null);
  assert.deepEqual(JSON.parse(probe.stdout), {
    protocol: "2026-07-28",
    probe: "extension method routing only",
    results: ["tasks/get", "tasks/cancel", "tasks/update"].map((method) => ({
      method,
      handlerReached: true,
      errorCode: null,
    })),
  });
});
