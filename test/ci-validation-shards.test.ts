import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { fixtureGit } from "./git-fixture.js";

const {
  validationShardCount,
  validationCohortCommandCount,
  validationShardManifest,
  validationShardPartitionSha256,
  validateValidationShards,
  parseValidationShardArgs,
  selectValidationShard,
  requireValidationShardAssignment,
} = await import(
  new URL("../../scripts/ci-validation-shards.mjs", import.meta.url).href
);
const { commandKey, validationPhases, runValidationLanes } = await import(
  new URL("../../scripts/ci-validation.mjs", import.meta.url).href
);
type Task = { script: string; args: string[]; env: Record<string, string> };
type Phases = { mutations: Task[]; packages: Task[] };
type Command = {
  state: string;
  command: string;
  temporary?: string;
  receipt?: { log: string };
};
type Fragment = {
  complete: boolean;
  assignedComplete: boolean;
  wholeCohortComplete: boolean;
  sourceStable: boolean;
  mutationsRestored: boolean;
  cleanupComplete: boolean;
  peakConcurrentCommandAdmissions: number;
  sourceSha256: string;
  assignment: {
    shard: number;
    shardCount: number;
    partitionSha256: string;
    assignedCommandCount: number;
    cohortCommandCount: number;
  };
  lanes: { commands: Command[] }[];
  logs: string;
};
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const keys = (phases: Phases): string[] =>
  Object.values(phases)
    .flat()
    .map((task: Task): string => commandKey(task))
    .sort();

async function temporary(t: TestContext) {
  const outer = await mkdtemp(path.join(tmpdir(), "checktrail-ci-shards-"));
  t.after(() => rm(outer, { recursive: true, force: true }));
  return outer;
}

async function syntheticRepository(t: TestContext, failScript?: string) {
  const outer = await temporary(t);
  const root = path.join(outer, "repository");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "dist/src"), { recursive: true });
  await mkdir(path.join(root, "node_modules"));
  await writeFile(
    path.join(root, ".gitignore"),
    "dist/\nnode_modules/\n.checktrail/\n",
  );
  await writeFile(path.join(root, "dist/src/subject.txt"), "original");
  const mutationScripts = (validationPhases as Phases).mutations.map(
    (task) => task.script,
  );
  const body = `
import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{setTimeout as delay}from'node:timers/promises';
import path from'node:path';
import process from'node:process';
const script='scripts/'+path.basename(process.argv[1]);
const file='dist/src/subject.txt';
assert.equal(await readFile(file,'utf8'),'original');
const mutation=${JSON.stringify(mutationScripts)}.includes(script);
if(mutation){await writeFile(file,'synthetic mutation');await delay(5);await writeFile(file,'original');}
assert.equal(await readFile(file,'utf8'),'original');
console.log(JSON.stringify({command:JSON.stringify([script,process.argv.slice(2),Object.entries(process.env.CHECKTRAIL_IMPORT_CONTEXT_PROFILE?{CHECKTRAIL_IMPORT_CONTEXT_PROFILE:process.env.CHECKTRAIL_IMPORT_CONTEXT_PROFILE}:{}).sort()]),root:process.cwd(),tmp:process.env.TMPDIR,pid:process.pid,mutation}));
if(script===${JSON.stringify(failScript ?? null)})process.exitCode=7;
`;
  for (const script of new Set(
    Object.values(validationPhases as Phases)
      .flat()
      .map((task) => task.script),
  ))
    await writeFile(path.join(root, script), body);
  fixtureGit(root, ["init", "--initial-branch=main"]);
  return { outer, root: await realpath(root) };
}

async function cliRepository(t: TestContext) {
  const outer = await temporary(t);
  const scripts = path.join(outer, "scripts");
  await mkdir(scripts);
  for (const name of [
    "run-ci-validation.mjs",
    "ci-validation-shards.mjs",
    "ci-validation-shards.json",
    "ci-validation-phases.json",
  ])
    await copyFile(
      path.join(sourceRoot, "scripts", name),
      path.join(scripts, name),
    );
  // This fixture tests actual CLI admission only. It cannot invoke real producers,
  // even if the CLI parser or the partition guard is broken.
  const marker = path.join(outer, "admitted.json");
  await writeFile(
    path.join(scripts, "ci-validation.mjs"),
    `import{writeFile}from'node:fs/promises';export async function runValidationLanes(root,options){const admission={root,defaultFull:options.phases===undefined,assignment:options.assignment??null,phases:options.phases??null};await writeFile(${JSON.stringify(marker)},JSON.stringify(admission));return admission;}`,
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(scripts, "run-ci-validation.mjs"), ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1048576,
      },
    );
  return { outer, scripts, marker, run };
}

test("host command shards freeze every complete command key in one disjoint three-role partition", () => {
  assert.equal(validationShardCount, 3);
  assert.equal(validationCohortCommandCount, 51);
  assert.equal(validateValidationShards(validationPhases), true);
  const selected = [0, 1, 2].map((shard) =>
    selectValidationShard(shard, validationPhases),
  );
  assert.deepEqual(
    selected.map(({ phases }: { phases: Phases }) => [
      phases.mutations.length,
      phases.packages.length,
    ]),
    [
      [6, 12],
      [3, 13],
      [5, 12],
    ],
  );
  const assignedKeys = selected.flatMap(({ phases }: { phases: Phases }) =>
    keys(phases),
  );
  assert.equal(assignedKeys.length, 51);
  assert.equal(new Set(assignedKeys).size, 51);
  assert.deepEqual(assignedKeys.sort(), keys(validationPhases));
  const importVariants = assignedKeys.filter((key: string) =>
    key.includes("verify-import-context-package"),
  );
  assert.equal(importVariants.length, 4);
  assert.equal(new Set(importVariants).size, 4);
  assert.equal(
    assignedKeys.filter((key: string) =>
      key.includes("verify-review-workflow-package"),
    ).length,
    2,
  );
  for (const row of selected) {
    requireValidationShardAssignment(row.phases, row.assignment);
    assert.equal(
      row.assignment.partitionSha256,
      validationShardPartitionSha256,
    );
    assert.equal(row.assignment.cohortCommandCount, 51);
  }
});

test("host shard preflight rejects two roles, duplicates, extras, moved commands and changed arguments or environment", () => {
  const mutations = [
    (p: typeof validationShardManifest) => p.shards.pop(),
    (p: typeof validationShardManifest) => {
      p.shards[2] = p.shards[1];
    },
    (p: typeof validationShardManifest) => {
      p.shards[0].packages.push(p.shards[0].packages[0]);
    },
    (p: typeof validationShardManifest) => {
      p.shards[0].packages.push('["scripts/foreign.mjs",[],[]]');
    },
    (p: typeof validationShardManifest) => {
      p.shards[1].packages.push(p.shards[0].packages.pop());
    },
    (p: typeof validationShardManifest) => {
      p.shards[0].mutations.push(p.shards[0].packages.pop());
    },
  ];
  for (const mutate of mutations) {
    const partition = globalThis.structuredClone(validationShardManifest);
    mutate(partition);
    assert.throws(
      () => selectValidationShard(0, validationPhases, partition),
      /Frozen CI shard partition changed/,
    );
  }
  for (const mutate of [
    (p: Phases) => {
      p.packages.pop();
    },
    (p: Phases) => {
      p.packages[0] = p.packages[1]!;
    },
    (p: Phases) => {
      p.packages[0]!.args.push("--all-candidates");
    },
    (p: Phases) => {
      p.packages[0]!.env = {
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "import-history",
      };
    },
    (p: Phases) => {
      p.packages[0]!.script = "scripts/foreign.mjs";
    },
  ]) {
    const phases = globalThis.structuredClone(validationPhases) as Phases;
    mutate(phases);
    assert.throws(() => selectValidationShard(0, phases));
  }
});

test("host shard CLI admits only its three exact roles and preserves the argument-free full runner", async (t) => {
  assert.equal(parseValidationShardArgs([]), undefined);
  for (const shard of [0, 1, 2])
    assert.equal(parseValidationShardArgs(["--shard" + shard]), shard);
  const invalid = [
    ["--shard3"],
    ["--shard-1"],
    ["--shard03"],
    ["--shard"],
    ["--shard", "0"],
    ["--shard0", "--shard1"],
    ["--shard0suffix"],
    ["prefix--shard0"],
    [""],
  ];
  const fixture = await cliRepository(t);
  for (const args of invalid) {
    assert.throws(
      () => parseValidationShardArgs(args),
      /Expected no arguments/,
    );
    const result = fixture.run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Expected no arguments/);
    await assert.rejects(access(fixture.marker), { code: "ENOENT" });
  }
  const full = fixture.run([]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const fullAdmission = JSON.parse(await readFile(fixture.marker, "utf8"));
  assert.equal(fullAdmission.defaultFull, true);
  assert.equal(fullAdmission.assignment, null);
  await rm(fixture.marker);
  for (const shard of [0, 1, 2]) {
    const result = fixture.run(["--shard" + shard]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const admission = JSON.parse(await readFile(fixture.marker, "utf8"));
    assert.equal(admission.defaultFull, false);
    assert.deepEqual(
      admission.assignment,
      selectValidationShard(shard).assignment,
    );
    assert.deepEqual(admission.phases, selectValidationShard(shard).phases);
    await rm(fixture.marker);
  }
});

test("a physical two-role CLI partition fails before any command while the intact three-role fixture admits each assignment", async (t) => {
  const fixture = await cliRepository(t);
  const partition = globalThis.structuredClone(validationShardManifest);
  partition.shards.pop();
  await writeFile(
    path.join(fixture.scripts, "ci-validation-shards.json"),
    JSON.stringify(partition),
  );
  const result = fixture.run(["--shard0"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Frozen CI shard partition changed/);
  await assert.rejects(access(fixture.marker), { code: "ENOENT" });
});

test("three real synthetic shard runs execute all 51 commands exactly once while each receipt remains a fragment", async (t) => {
  const { root } = await syntheticRepository(t);
  const fragments: Fragment[] = [];
  const actualKeys: string[] = [];
  const pids = new Set<number>();
  const namespaces = new Set<string>();
  for (const shard of [0, 1, 2]) {
    const selected = selectValidationShard(shard);
    const result: Fragment = await runValidationLanes(root, {
      ...selected,
      timeoutMs: 15000,
    });
    fragments.push(result);
    assert.equal(
      result.complete,
      false,
      "One shard must not qualify the whole cohort",
    );
    assert.equal(result.assignedComplete, true);
    assert.equal(result.wholeCohortComplete, false);
    assert.deepEqual(result.assignment, selected.assignment);
    assert.equal(result.sourceStable, true);
    assert.equal(result.mutationsRestored, true);
    assert.equal(result.cleanupComplete, true);
    assert.ok(result.peakConcurrentCommandAdmissions <= 2);
    const commands = result.lanes.flatMap((lane) => lane.commands);
    assert.equal(commands.length, selected.assignment.assignedCommandCount);
    assert.ok(commands.every((command) => command.state === "passed"));
    const mutationRoots = new Set<string>();
    for (const command of commands) {
      const body = JSON.parse(await readFile(command.receipt!.log, "utf8"));
      assert.equal(body.command, command.command);
      actualKeys.push(body.command);
      pids.add(body.pid);
      namespaces.add(body.tmp);
      await assert.rejects(access(body.tmp), { code: "ENOENT" });
      if (body.mutation) {
        assert.notEqual(body.root, root);
        mutationRoots.add(body.root);
      }
    }
    assert.equal(mutationRoots.size, 1);
    for (const mutationRoot of mutationRoots)
      await assert.rejects(access(mutationRoot), { code: "ENOENT" });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(result.logs, "result.json"), "utf8")),
      result,
    );
  }
  assert.equal(actualKeys.length, 51);
  assert.equal(new Set(actualKeys).size, 51);
  assert.deepEqual(actualKeys.sort(), keys(validationPhases));
  assert.equal(pids.size, 51);
  assert.equal(namespaces.size, 51);
  assert.equal(
    new Set(fragments.map((fragment) => fragment.sourceSha256)).size,
    1,
  );
  assert.equal(
    await readFile(path.join(root, "dist/src/subject.txt"), "utf8"),
    "original",
  );
});

test("scheduler rejects missing assigned commands and forged shard identities before opening any repository", async () => {
  const selected = selectValidationShard(0);
  const missing = globalThis.structuredClone(selected.phases) as Phases;
  missing.packages.pop();
  await assert.rejects(
    runValidationLanes("/not-a-host-shard-repository", {
      phases: missing,
      assignment: selected.assignment,
    }),
    /Assigned CI commands are missing, duplicated, moved or changed/,
  );
  for (const change of [
    { shard: 3 },
    { shard: 1 },
    { assignedCommandCount: 51 },
    { cohortCommandCount: 18 },
    { partitionSha256: "0".repeat(64) },
  ])
    await assert.rejects(
      runValidationLanes("/not-a-host-shard-repository", {
        ...selected,
        assignment: { ...selected.assignment, ...change },
      }),
      /Unknown CI shard role|CI shard assignment changed/,
    );
});

test("failed synthetic shard retains failed and unrun commands without completing its assigned fragment", async (t) => {
  const selected = selectValidationShard(0);
  const { root } = await syntheticRepository(
    t,
    selected.phases.mutations[0].script,
  );
  let fragment: Fragment | undefined;
  try {
    await runValidationLanes(root, { ...selected, timeoutMs: 15000 });
    assert.fail("The physically failing command must fail its assigned shard");
  } catch (error) {
    fragment = (error as { result?: Fragment }).result;
  }
  assert.ok(fragment);
  assert.equal(fragment.complete, false);
  assert.equal(fragment.assignedComplete, false);
  assert.equal(fragment.wholeCohortComplete, false);
  assert.equal(fragment.cleanupComplete, true);
  assert.equal(fragment.sourceStable, true);
  assert.equal(fragment.mutationsRestored, true);
  assert.deepEqual(fragment.assignment, selected.assignment);
  const commands = fragment.lanes.flatMap((lane) => lane.commands);
  assert.equal(commands.length, selected.assignment.assignedCommandCount);
  assert.ok(commands.some((command) => command.state === "failed"));
  assert.ok(commands.some((command) => command.state === "unrun"));
  assert.ok(
    commands
      .filter((command) => command.state === "unrun")
      .every((command) => command.receipt === undefined),
  );
});
