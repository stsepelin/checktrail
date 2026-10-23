import process from "node:process";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { verifyReviewRuntime } from "./review-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const result = await verifyReviewRuntime({ slot: process.argv[2] ?? null });
const output = JSON.stringify(result) + "\n";
assert.ok(
  Buffer.byteLength(output) <= 4 * 1048576,
  "Runtime evidence output exceeds bound",
);
process.stdout.write(output);
