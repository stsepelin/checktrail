import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

export const validationShardCount = 3;
export const validationCohortCommandCount = 51;
// Count-balanced command assignments have not yet been timed on hosted runners.
export const validationShardPartitionSha256 =
  "0ffdb87c45a5fb61ca2356431dae128846f318dcb366dcb804f3f1f1f2a4c08f";

const canonicalPhases = JSON.parse(
  await readFile(
    new URL("./ci-validation-phases.json", import.meta.url),
    "utf8",
  ),
);
const frozenPartition = JSON.parse(
  await readFile(
    new URL("./ci-validation-shards.json", import.meta.url),
    "utf8",
  ),
);
const key = ({ script, args, env }) =>
  JSON.stringify([script, args, Object.entries(env).sort()]);
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const validationShardManifest = freeze(frozenPartition);

export function validateValidationShards(
  phases = canonicalPhases,
  partition = validationShardManifest,
) {
  assert.equal(
    digest(partition),
    validationShardPartitionSha256,
    "Frozen CI shard partition changed",
  );
  assert.deepEqual(Object.keys(partition).sort(), [
    "profile",
    "schemaVersion",
    "shards",
  ]);
  assert.equal(partition.schemaVersion, 1);
  assert.equal(partition.profile, "host-validation-command-partition-v1");
  assert.equal(partition.shards.length, validationShardCount);
  assert.deepEqual(
    partition.shards.map((shard) => shard.id),
    [0, 1, 2],
    "Every closed CI shard role must be present exactly once",
  );
  assert.deepEqual(Object.keys(phases).sort(), ["mutations", "packages"]);
  let total = 0;
  const all = new Set();
  for (const lane of ["mutations", "packages"]) {
    const assigned = [];
    for (const shard of partition.shards) {
      assert.deepEqual(Object.keys(shard).sort(), [
        "id",
        "mutations",
        "packages",
      ]);
      assert.ok(Array.isArray(shard[lane]) && shard[lane].length > 0);
      for (const command of shard[lane]) {
        assert.equal(typeof command, "string");
        assert.ok(!all.has(command), "CI command assigned more than once");
        all.add(command);
        assigned.push(command);
      }
    }
    assert.ok(Array.isArray(phases[lane]));
    assert.equal(phases[lane].length, lane === "mutations" ? 14 : 37);
    assert.deepEqual(
      phases[lane].map(key).sort(),
      assigned.sort(),
      "CI shard commands differ from the complete canonical " +
        lane +
        " cohort",
    );
    total += assigned.length;
  }
  assert.equal(total, validationCohortCommandCount);
  return true;
}

export function parseValidationShardArgs(args) {
  assert.ok(Array.isArray(args));
  if (args.length === 0) return undefined;
  assert.ok(
    args.length === 1 && /^--shard[0-2]$/u.test(args[0]),
    "Expected no arguments or exactly --shard0, --shard1 or --shard2",
  );
  return Number(args[0].slice(-1));
}

export function selectValidationShard(
  shard,
  phases = canonicalPhases,
  partition = validationShardManifest,
) {
  validateValidationShards(phases, partition);
  assert.ok(
    Number.isSafeInteger(shard) && shard >= 0 && shard < validationShardCount,
    "Unknown CI shard role",
  );
  const selected = partition.shards[shard];
  const assigned = {};
  for (const lane of ["mutations", "packages"]) {
    const tasks = new Map(phases[lane].map((task) => [key(task), task]));
    assigned[lane] = selected[lane].map((command) =>
      JSON.parse(JSON.stringify(tasks.get(command))),
    );
  }
  return {
    phases: assigned,
    assignment: {
      schemaVersion: 1,
      scope: "assigned-host-validation-shard",
      shard,
      shardCount: validationShardCount,
      partitionSha256: validationShardPartitionSha256,
      cohortCommandCount: validationCohortCommandCount,
      assignedCommandCount:
        assigned.mutations.length + assigned.packages.length,
      commandKeys: {
        mutations: [...selected.mutations],
        packages: [...selected.packages],
      },
    },
  };
}

export function requireValidationShardAssignment(phases, assignment) {
  assert.ok(assignment && typeof assignment === "object");
  const expected = selectValidationShard(assignment.shard);
  assert.deepEqual(
    assignment,
    expected.assignment,
    "CI shard assignment changed",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(phases).map(([lane, tasks]) => [lane, tasks.map(key)]),
    ),
    expected.assignment.commandKeys,
    "Assigned CI commands are missing, duplicated, moved or changed",
  );
}
