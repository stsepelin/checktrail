import assert from "node:assert/strict";
import process from "node:process";
import { verifyAttemptRuntime } from "./attempt-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
process.stdout.write(
  JSON.stringify(
    await verifyAttemptRuntime({ slot: process.argv[2] ?? null }),
  ) + "\n",
);
