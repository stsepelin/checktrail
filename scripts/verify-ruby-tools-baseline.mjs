import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
const shard = process.argv[2] ?? "all";
assert.ok(["all", "1", "2", "3"].includes(shard));
const requirements = JSON.parse(
  await readFile(
    new URL("./required-native-tests.json", import.meta.url),
    "utf8",
  ),
)["ruby-tools"];
assert.ok(requirements.length > 0);
assert.equal(
  new Set(requirements.map((c) => JSON.stringify([c.file, c.name]))).size,
  requirements.length,
);
const selected = requirements.filter(
  (_, i) => shard === "all" || i % 3 === Number(shard) - 1,
);
assert.ok(selected.length > 0);
const result = await runRequiredTests(selected, {
  timeoutMs: 1200000,
  isolatedCaseWorkers: 1,
});
process.stdout.write(
  JSON.stringify({
    profile: "ruby-tools",
    baselineShard: shard,
    fullRequiredInventory: requirements,
    timeoutMs: 1200000,
    ...result,
  }) + "\n",
);
process.exitCode = result.complete ? 0 : 1;
