import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { runRequiredTests } from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import {
  loadGeneratorShards,
  selectGeneratorShard,
  parseGeneratorShardArguments,
  requireGeneratorRoleEvidence,
  generatorCaseKey,
  validateGeneratorJobContext,
} from "./dotnet-generator-shards.mjs";

export function generatorShardRunOptions(role) {
  assert.ok(
    ["baseline", "source"].includes(role),
    "Unknown generator shard role",
  );
  // Both roles split callbacks across shards. Whole-file execution repeats
  // unselected callbacks; use one fresh named process at a time for both.
  return { timeoutMs: 600000, isolatedCaseWorkers: 1 };
}

export async function runGeneratorShardRole(
  repository,
  id,
  role,
  { run = runRequiredTests, capture = captureCompiledEngine } = {},
) {
  assert.ok(
    ["baseline", "source"].includes(role),
    "Unknown generator shard role",
  );
  const loaded = await loadGeneratorShards(repository);
  const shard = selectGeneratorShard(loaded.manifest, id);
  const rows = shard[role];
  const root = path.join(repository, "dist/src");
  const before = await capture(root);
  const report = await run(
    rows.map((row) => ({ ...row, file: path.join(repository, row.file) })),
    generatorShardRunOptions(role),
  );
  report.compiledEngine = requireUnchangedCompiledEngine(
    before,
    await capture(root),
  );
  requireGeneratorRoleEvidence(report, rows);
  return {
    schemaVersion: 1,
    scope: "dotnet-generator-required-role-fragment",
    shard: id,
    role,
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    requiredCaseKeys: rows.map(generatorCaseKey),
    evidence: report,
    fragmentComplete: true,
    wholeProfileQualification: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(process.argv.length, 5, "Use --shard ID baseline|source");
  const id = parseGeneratorShardArguments(process.argv.slice(2, 4));
  const context = validateGeneratorJobContext(
    JSON.parse(process.env.CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT),
  );
  const result = await runGeneratorShardRole(
    fileURLToPath(new URL("../", import.meta.url)),
    id,
    process.argv[4],
  );
  process.stdout.write(JSON.stringify({ ...result, context }) + "\n");
}
