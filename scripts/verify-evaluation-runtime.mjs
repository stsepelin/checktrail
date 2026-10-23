import assert from "node:assert/strict";
import process from "node:process";
import { verifyEvaluationRuntime } from "./evaluation-runtime-evidence.mjs";
assert.ok(process.argv.length === 2 || process.argv.length === 3);
const result = await verifyEvaluationRuntime({ slot: process.argv[2] ?? null });
process.stdout.write(JSON.stringify(result) + "\n");
