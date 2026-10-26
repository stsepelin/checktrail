import assert from "node:assert/strict";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fixture } from "./helpers.js";
import {
  waitForMcpStartup,
  waitForValidationPid,
  waitForMcpShutdown,
} from "./mcp-lifecycle-waits.js";

test("MCP lifecycle startup allows a delayed marker beyond the old polling window and starts the shutdown bound only when requested", async (t) => {
  const root = await fixture(t, {}),
    child = { exitCode: null, signalCode: null };
  const writer = delay(2800).then(async () => {
    await mkdir(path.join(root, ".checktrail"), { recursive: true });
    await writeFile(
      path.join(root, ".checktrail", "starting.json"),
      JSON.stringify({ pid: 123, parent: 456 }),
    );
    await rename(
      path.join(root, ".checktrail", "starting.json"),
      path.join(root, ".checktrail", "started.json"),
    );
  });
  const ready = waitForValidationPid(root, child),
    closed = new Promise<void>(() => {});
  try {
    assert.deepEqual(await waitForMcpStartup(ready, closed), {
      pid: 123,
      parent: 456,
    });
  } finally {
    await writer;
  }
  assert.equal(
    await waitForMcpShutdown(Promise.resolve("closed"), 20),
    "closed",
  );
  await assert.rejects(
    waitForMcpShutdown(closed, 20),
    /shutdown deadline exceeded/,
  );
});

test("MCP lifecycle phase waits refuse early exits malformed markers and missing startup or shutdown evidence", async (t) => {
  const root = await fixture(t, {}),
    pending = new Promise<void>(() => {});
  await assert.rejects(
    waitForMcpStartup(pending, Promise.resolve()),
    /closed before startup/,
  );
  await assert.rejects(
    waitForMcpStartup(pending, pending, 20),
    /startup evidence deadline/,
  );
  await assert.rejects(
    waitForValidationPid(root, { exitCode: 0, signalCode: null }),
    /closed before validation/,
  );
  await assert.rejects(
    waitForValidationPid(root, { exitCode: null, signalCode: "SIGTERM" }),
    /closed before validation/,
  );
  await assert.rejects(
    waitForValidationPid(root, { exitCode: null, signalCode: null }, 20),
    /startup evidence deadline/,
  );
  await mkdir(path.join(root, ".checktrail"), { recursive: true });
  for (const marker of [
    "{invalid",
    JSON.stringify({ pid: 0, parent: 2 }),
    JSON.stringify({ pid: 1, parent: "2" }),
  ]) {
    await writeFile(path.join(root, ".checktrail", "started.json"), marker);
    await assert.rejects(
      waitForValidationPid(root, { exitCode: null, signalCode: null }),
    );
  }
  assert.throws(
    () => waitForMcpShutdown(Promise.resolve(), 0),
    /Invalid lifecycle/,
  );
});
