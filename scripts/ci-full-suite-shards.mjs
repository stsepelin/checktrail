import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  fullSuiteBatches,
  runRequiredProfiles,
} from "./required-test-evidence.mjs";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";

export const fullSuiteShardIds = Object.freeze(["0", "1", "2"]);
// Relative scheduling hints, not measured durations or validation deadlines.
export const exclusiveSchedulingWeights = Object.freeze({
  "gate-javascript-extensions.test.js": 600,
  "gate-go-extensions.test.js": 450,
  "gate-tasks-matrix.test.js": 350,
  "gate-lifecycle-platforms.test.js": 300,
  "gate-resource-release-readiness.test.js": 250,
  "go-matrix.test.js": 180,
  "review-json-probe.test.js": 180,
  "review-probe.test.js": 180,
  "process-tree.test.js": 120,
  "posix-owner.test.js": 120,
  "clang.test.js": 90,
});
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const filePattern = /^[a-z0-9][a-z0-9-]*\.test\.js$/u;
const exact = (value, keys) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
export function requireFullSuitePartition(partition, inventory) {
  exact(partition, ["schemaVersion", "inventorySha256", "shards"]);
  assert.equal(partition.schemaVersion, 1);
  assert.equal(partition.inventorySha256, digest(inventory));
  assert.ok(Array.isArray(partition.shards));
  assert.deepEqual(
    partition.shards.map((row) => row.id),
    fullSuiteShardIds,
  );
  const assigned = [];
  for (const row of partition.shards) {
    exact(row, ["id", "files"]);
    assert.ok(
      Array.isArray(row.files) && row.files.length > 0,
      "Empty full-suite shard",
    );
    assert.ok(
      row.files.every(
        (file) => typeof file === "string" && filePattern.test(file),
      ),
    );
    assigned.push(...row.files);
  }
  assert.equal(
    new Set(assigned).size,
    assigned.length,
    "Overlapping full-suite shards",
  );
  assert.deepEqual(
    assigned.toSorted(),
    inventory.map((row) => row.file).toSorted(),
    "Full-suite file partition is incomplete",
  );
  return partition;
}
export function partitionFullSuiteFiles(inventory) {
  assert.ok(
    Array.isArray(inventory) &&
      inventory.length >= 3 &&
      inventory.length <= 4096,
    "Full-suite inventory cannot form three bounded shards",
  );
  const files = inventory.map((row) => {
    exact(row, ["file", "bytes", "sha256"]);
    assert.ok(typeof row.file === "string" && filePattern.test(row.file));
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0);
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
    return row.file;
  });
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(
    files,
    files.toSorted(),
    "Full-suite inventory must be canonical",
  );
  const exclusive = new Set(
    fullSuiteBatches(files)
      .filter((row) => row.exclusive)
      .flatMap((row) => row.files),
  );
  const weighted = inventory
    .map((row) => {
      if (exclusive.has(row.file))
        assert.ok(
          Object.hasOwn(exclusiveSchedulingWeights, row.file),
          "Unreviewed exclusive scheduling weight",
        );
      return {
        file: row.file,
        weight: exclusive.has(row.file)
          ? exclusiveSchedulingWeights[row.file]
          : Math.max(1, Math.ceil(row.bytes / 4096)),
      };
    })
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file, "en"));
  const shards = fullSuiteShardIds.map((id) => ({ id, files: [], weight: 0 }));
  for (const row of weighted) {
    const target = shards.toSorted(
      (a, b) => a.weight - b.weight || a.id.localeCompare(b.id),
    )[0];
    target.files.push(row.file);
    target.weight += row.weight;
  }
  return requireFullSuitePartition(
    {
      schemaVersion: 1,
      inventorySha256: digest(inventory),
      shards: shards.map(({ id, files }) => ({ id, files: files.toSorted() })),
    },
    inventory,
  );
}
export async function captureFullSuiteInventory(repository) {
  const sourceDirectory = path.join(repository, "test"),
    compiledDirectory = path.join(repository, "dist/test");
  for (const directory of [sourceDirectory, compiledDirectory]) {
    const stat = await lstat(directory);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink(),
      "Full-suite roots must be physical directories",
    );
  }
  const sourceNames = (await readdir(sourceDirectory))
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
  for (const file of sourceNames)
    assert.ok(
      (await lstat(path.join(sourceDirectory, file))).isFile(),
      "Full-suite source is not a regular file",
    );
  const snapshot = await captureCompiledEngine(compiledDirectory);
  const inventory = snapshot.files
    .filter(
      (row) =>
        row.file.endsWith(".test.js") &&
        !row.file.includes("/") &&
        !row.file.includes("\\"),
    )
    .map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  assert.deepEqual(
    inventory.map((row) => row.file),
    sourceNames.map((file) => file.replace(/\.ts$/u, ".js")),
    "Compiled full suite is missing source tests or contains stale tests",
  );
  return { inventory, snapshot };
}
export function selectFullSuiteRequirements(
  profiles,
  selection,
  inventory,
  assignedFiles,
) {
  assert.ok(
    Array.isArray(selection) && selection.length > 0 && selection.length <= 256,
  );
  assert.equal(
    new Set(selection).size,
    selection.length,
    "Duplicate required profile",
  );
  assert.ok(
    !selection.some((profile) =>
      [
        "mutation-runners",
        "mutation-vitest",
        "mutation-jest",
        "mutation-pytest",
        "mutation-phpunit",
      ].includes(profile),
    ),
    "Native mutation cohorts run separately",
  );
  const known = new Set(inventory.map((row) => "dist/test/" + row.file)),
    assigned = new Set(assignedFiles.map((file) => "dist/test/" + file));
  const selectedProfiles = Object.create(null),
    allCases = new Set(),
    assignedCases = new Set();
  for (const profile of selection) {
    assert.ok(
      typeof profile === "string" && Object.hasOwn(profiles, profile),
      "Unknown required native test profile",
    );
    const rows = profiles[profile];
    assert.ok(
      Array.isArray(rows) && rows.length > 0 && rows.length <= 256,
      "Invalid required profile",
    );
    const unique = new Set();
    for (const row of rows) {
      exact(row, ["file", "name"]);
      assert.ok(
        typeof row.file === "string" && known.has(row.file),
        "Required profile points outside the complete test inventory",
      );
      assert.ok(
        typeof row.name === "string" &&
          row.name.length > 0 &&
          row.name.length <= 512,
      );
      const key = JSON.stringify([row.file, row.name]);
      assert.ok(!unique.has(key), "Duplicate required callback");
      unique.add(key);
      allCases.add(key);
      if (assigned.has(row.file)) assignedCases.add(key);
    }
    const filtered = rows.filter((row) => assigned.has(row.file));
    if (filtered.length) selectedProfiles[profile] = filtered;
  }
  assert.ok(
    assignedCases.size > 0,
    "Full-suite shard has no required native callbacks",
  );
  return {
    profiles: selectedProfiles,
    selection: Object.keys(selectedProfiles),
    allRequired: allCases.size,
    assignedRequired: assignedCases.size,
  };
}
export function requireFullSuiteFileEvidence(
  report,
  inventory,
  assignedFiles,
  selected,
) {
  const names = [
    ...new Set([
      ...selected.selection.flatMap((profile) =>
        selected.profiles[profile].map((row) =>
          row.file.slice("dist/test/".length),
        ),
      ),
      ...assignedFiles,
    ]),
  ];
  assert.equal(
    report.files,
    names.length,
    "Shard file evidence inventory differs",
  );
  assert.equal(
    report.ledger.files.length,
    names.length,
    "Shard file evidence inventory differs",
  );
  for (const [index, file] of names.entries()) {
    const row = report.ledger.files[index],
      expected = inventory.find((entry) => entry.file === file);
    assert.ok(expected && assignedFiles.includes(file));
    assert.equal(
      row.id,
      "file-" + (index + 1),
      "Shard file evidence addresses differ",
    );
    assert.equal(row.stable, true, "Shard file evidence is unstable");
    assert.equal(row.before.state, "present");
    assert.equal(row.after.state, "present");
    assert.equal(
      row.before.sha256,
      expected.sha256,
      "Shard callback evidence differs from the inventoried test source",
    );
    assert.equal(
      row.after.sha256,
      expected.sha256,
      "Shard callback evidence differs from the inventoried test source",
    );
  }
  return names.map((file, index) => {
    const durations = report.ledger.events
      .filter(
        (row) =>
          row.fileId === "file-" + (index + 1) &&
          Number.isFinite(row.durationMs) &&
          row.durationMs >= 0,
      )
      .map((row) => row.durationMs);
    return {
      file,
      observedDurationEvents: durations.length,
      inclusiveCallbackDurationMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0))
        : null,
    };
  });
}

export async function runFullSuiteShard(repository, id, selection) {
  const started = performance.now();
  assert.equal(
    await realpath(repository),
    await realpath(process.cwd()),
    "Full-suite shard requires its selected repository working directory",
  );
  const manifest = JSON.parse(
    await readFile(
      path.join(repository, "scripts/ci-full-suite-profiles.json"),
      "utf8",
    ),
  );
  exact(manifest, ["schemaVersion", "profiles", "remainingCommands"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(
    Array.isArray(manifest.profiles) &&
      Array.isArray(manifest.remainingCommands),
  );
  if (selection === undefined || selection.length === 0)
    selection = manifest.profiles;
  assert.deepEqual(
    selection,
    manifest.profiles,
    "A full-suite shard cannot omit required profiles",
  );
  assert.ok(fullSuiteShardIds.includes(id), "Unknown full-suite shard");
  const profiles = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
  const before = await captureFullSuiteInventory(repository),
    partition = partitionFullSuiteFiles(before.inventory);
  const shard = partition.shards.find((row) => row.id === id);
  const selected = selectFullSuiteRequirements(
    profiles,
    selection,
    before.inventory,
    shard.files,
  );
  const engineRoot = path.join(repository, "dist/src"),
    engineBefore = await captureCompiledEngine(engineRoot);
  const report = await runRequiredProfiles(
    selected.profiles,
    selected.selection,
    {
      timeoutMs: 600000,
      additionalFiles: shard.files.map((file) =>
        path.join(repository, "dist/test", file),
      ),
    },
  );
  const timingHints = requireFullSuiteFileEvidence(
    report,
    before.inventory,
    shard.files,
    selected,
  );
  const engine = requireUnchangedCompiledEngine(
    engineBefore,
    await captureCompiledEngine(engineRoot),
  );
  const after = await captureFullSuiteInventory(repository);
  const testFiles = requireUnchangedCompiledEngine(
    before.snapshot,
    after.snapshot,
  );
  const fragmentComplete =
    report.complete && report.required === selected.assignedRequired;
  return {
    ...report,
    elapsedMilliseconds: Math.round(performance.now() - started),
    timingHints,
    complete: false,
    fragmentComplete,
    wholeSuiteComplete: false,
    requestedProfiles: selection,
    profileManifestSha256: digest(manifest),
    scope:
      "Assigned complete test files and their required callbacks only; all three CI rows are required for the full-suite cohort",
    shard: id,
    partitionSha256: digest(partition),
    inventorySha256: partition.inventorySha256,
    assignedFiles: shard.files,
    unassignedFiles: before.inventory
      .map((row) => row.file)
      .filter((file) => !shard.files.includes(file)),
    totalRequired: selected.allRequired,
    assignedRequired: selected.assignedRequired,
    compiledEngine: engine,
    compiledTests: {
      treeSha256: testFiles.treeSha256,
      beforeAfterByteIdentitiesMatch: testFiles.beforeAfterByteIdentitiesMatch,
    },
  };
}
