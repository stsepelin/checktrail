import assert from "node:assert/strict";
import process from "node:process";
import { verifyConsumerRuntime } from "./consumer-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
process.stdout.write(
  JSON.stringify(
    await verifyConsumerRuntime({ slot: process.argv[2] ?? null }),
  ) + "\n",
);
