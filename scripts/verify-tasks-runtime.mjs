import assert from "node:assert/strict";
import process from "node:process";
import { verifyTasksRuntime } from "./tasks-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const result = await verifyTasksRuntime({
  slot: process.argv[2] ?? null,
  requireHostedIdentity: process.env.GITHUB_ACTIONS === "true",
});
process.stdout.write(JSON.stringify(result) + "\n");
