import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  captureFullSuiteInventory,
  partitionFullSuiteFiles,
  runFullSuiteShard,
  selectFullSuiteBaselinePartition,
  selectFullSuiteRequirements,
} from "./ci-full-suite-shards.mjs";
import {
  captureBaselineSourceExecution,
  selectBaselineCohort,
} from "./preserved-baseline-evidence.mjs";
import {
  baselineRuntimeBinding,
  completeFreshBaseline,
} from "./preserved-baseline-fresh-coordinator.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function runFullSuiteShardWithBaseline(repository, id, selection) {
  repository = await realpath(repository);
  assert.equal(
    process.platform,
    "linux",
    "Host baseline requires its selected Linux runtime",
  );
  assert.equal(
    Number(process.versions.node.split(".")[0]),
    22,
    "Host baseline requires its selected Node major",
  );
  const baseline = await selectBaselineCohort(repository, "host-core");
  const manifest = JSON.parse(
    await readFile(
      path.join(repository, "scripts/ci-full-suite-profiles.json"),
      "utf8",
    ),
  );
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  if (selection === undefined || selection.length === 0)
    selection = manifest.profiles;
  assert.deepEqual(
    selection,
    manifest.profiles,
    "Original full-suite profile union changed",
  );
  const before = await captureFullSuiteInventory(repository);
  const partition = partitionFullSuiteFiles(before.inventory);
  const shard = partition.shards.find((row) => row.id === id);
  assert.ok(shard, "Unknown source fragment");
  const original = selectFullSuiteRequirements(
    profiles,
    selection,
    before.inventory,
    shard.files,
  );
  const frozenPartition = selectFullSuiteBaselinePartition({
    profiles,
    selection,
    baselineProfiles: baseline.profiles,
    baselineSelection: baseline.selection,
    inventory: before.inventory,
    partition,
  });
  const frozen = frozenPartition.fragments.find((row) => row.shard === id);
  const expectedSourceScope = {
    profiles: original.profiles,
    selection: original.selection,
    additionalFiles: shard.files.map((file) => "dist/test/" + file),
    baselineProfiles: frozen.profiles,
    baselineSelection: frozen.selection,
    binding: baselineRuntimeBinding(baseline.cohort),
    sourceContract: {
      kind: "full-suite-fragment",
      maxTerminalEvents: 4096,
      fragment: {
        shard: id,
        partitionSha256: digest(partition),
        inventorySha256: partition.inventorySha256,
        profileManifestSha256: digest(manifest),
        requestedProfiles: manifest.profiles,
        totalRequired: original.allRequired,
        assignedRequired: original.assignedRequired,
        assignedFiles: shard.files,
        unassignedFiles: before.inventory
          .map((row) => row.file)
          .filter((file) => !shard.files.includes(file)),
        compiledTestsTreeSha256: before.snapshot.treeSha256,
      },
    },
  };
  const sourceCapture = await captureBaselineSourceExecution({
    root: repository,
    ...expectedSourceScope,
    execute: () => runFullSuiteShard(repository, id, selection),
  });
  const fresh = await completeFreshBaseline({
    repository,
    sourceCapture,
    expectedSourceScope,
    preparedDirectories: baseline.cohort.preparedDirectories,
    launchWorker: ({ harness, inputFile, worker }) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.CHECKTRAIL_PRESERVED_BASELINE;
      return execFileSync(process.execPath, [worker, inputFile], {
        cwd: harness,
        env,
        encoding: "utf8",
        timeout: 660000,
        maxBuffer: 32 * 1024 * 1024,
      });
    },
  });
  assert.equal(fresh.fresh.required, frozen.required);
  const directory = path.join(repository, ".checktrail/preserved-baseline");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "host-shard-" + id + ".json");
  const receipt = {
    schemaVersion: 1,
    cohort: "host-core",
    shard: id,
    identities: baseline.identities,
    frozenPartition,
    fresh,
    allThreeFragmentsRequired: true,
    wholeCohortComplete: false,
    wholeSuiteQualification: false,
    gateAComplete: false,
  };
  const bytes = JSON.stringify(receipt) + "\n";
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return {
    report: sourceCapture.originalReport,
    baselineEvidence: receipt,
    baseline: {
      cohort: "host-core",
      shard: id,
      required: frozen.required,
      memberships: frozen.memberships,
      sourceAndFreshSubsetComplete: true,
      allThreeFragmentsRequired: true,
      wholeCohortComplete: false,
      receiptSha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
