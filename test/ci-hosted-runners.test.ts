import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Job = {
  "runs-on": string;
  steps: { run?: string; "timeout-minutes"?: number }[];
  strategy?: { matrix?: { include?: { os?: string }[] } };
};
type Workflow = { on?: Record<string, unknown>; jobs: Record<string, Job> };
const directory = new URL("../../.github/workflows/", import.meta.url);
const workflows = new Map<string, Workflow>(
  await Promise.all(
    (await readdir(directory))
      .filter((name) => /\.ya?ml$/u.test(name))
      .map(async (name): Promise<[string, Workflow]> => [
        name,
        parse(await readFile(new URL(name, directory), "utf8")) as Workflow,
      ]),
  ),
);
const allowed = new Set([
  "ubuntu-26.04",
  "ubuntu-26.04-arm",
  "macos-latest",
  "macos-26",
  "windows-2025",
]);
function verifyLabels(workflow: Workflow, filename?: string) {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const runner = job["runs-on"];
    const labels =
      runner === "${{ matrix.os }}"
        ? job.strategy?.matrix?.include?.map((row) => row.os)
        : [runner];
    assert.ok(labels?.length, `${id} must declare its runner labels`);
    for (const label of labels)
      assert.ok(
        label !== undefined &&
          (allowed.has(label) ||
            (filename === "native-tree027-producer.yml" &&
              id === "producer" &&
              label === "macos-15")),
        `${id} has an unselected runner: ${label}`,
      );
  }
}

test("every workflow selects the explicit Ubuntu 26.04 hosted labels", () => {
  assert.ok(workflows.size > 0);
  for (const [filename, workflow] of workflows)
    verifyLabels(workflow, filename);
  const original = workflows.get("ci.yml")!;
  for (const label of [
    "ubuntu-latest",
    "ubuntu-24.04",
    "ubuntu-26.04-arm64",
    "ubuntu-26.04-arm-extra",
    "ubuntu-26.040",
  ]) {
    const changed = structuredClone(original);
    changed.jobs["ci-plan"]!["runs-on"] = label;
    assert.throws(() => verifyLabels(changed), /unselected runner/u);
    const matrix = structuredClone(original);
    matrix.jobs.checks!.strategy!.matrix!.include![0]!.os = label;
    assert.throws(() => verifyLabels(matrix), /unselected runner/u);
  }
});

test("Tree-sitter original producer alone retains its selected macOS 15 runner", () => {
  const filename = "native-tree027-producer.yml";
  const workflow = workflows.get(filename)!;
  assert.deepEqual(Object.keys(workflow.on ?? {}), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["producer"]);
  assert.equal(workflow.jobs.producer!["runs-on"], "macos-15");
  verifyLabels(workflow, filename);
  for (const wrongName of [
    undefined,
    "ci.yml",
    filename + ".extra",
    "prefix-" + filename,
  ]) {
    assert.throws(
      () => verifyLabels(workflow, wrongName),
      /unselected runner/u,
    );
  }
  const wrongJob = structuredClone(workflow);
  wrongJob.jobs.other = wrongJob.jobs.producer!;
  delete wrongJob.jobs.producer;
  assert.throws(() => verifyLabels(wrongJob, filename), /unselected runner/u);
  for (const label of [
    "macos-15-intel",
    "macos-15-large",
    "macos-150",
    "macos-15-extra",
  ]) {
    const changed = structuredClone(workflow);
    changed.jobs.producer!["runs-on"] = label;
    assert.throws(() => verifyLabels(changed, filename), /unselected runner/u);
  }
});

test("the pinned actionlint compatibility declaration allows only the two exact hosted labels", async () => {
  const config = parse(
    await readFile(new URL("../actionlint.yaml", directory), "utf8"),
  );
  assert.deepEqual(config, {
    "self-hosted-runner": { labels: ["ubuntu-26.04", "ubuntu-26.04-arm"] },
  });
});

test("macOS runner selections and runtime pins retain their existing matrix", () => {
  const jobs = workflows.get("ci.yml")!.jobs;
  const selected: Record<string, unknown> = {};
  for (const [id, job] of Object.entries(jobs)) {
    if (job["runs-on"].startsWith("macos-")) {
      selected[id] = job["runs-on"];
      continue;
    }
    const rows = job.strategy?.matrix?.include?.filter((row) =>
      row.os?.startsWith("macos-"),
    );
    if (rows?.length) selected[id] = rows;
  }
  const runtime = [
    { slot: "ci-macos-node22", os: "macos-26", node: "22.23.3" },
    { slot: "ci-macos-node24", os: "macos-26", node: "24.20.0" },
    { slot: "ci-macos-node26", os: "macos-26", node: "26.9.0" },
  ];
  assert.deepEqual(selected, {
    checks: [{ os: "macos-latest", node: "24" }],
    "full-suite-shards": [
      { os: "macos-latest", node: "24", shard: 1 },
      { os: "macos-latest", node: "24", shard: 2 },
    ],
    "host-validation": [0, 1, 2].map((shard) => ({
      os: "macos-latest",
      node: "24",
      shard,
    })),
    swift: "macos-latest",
    "tasks-runtime": runtime.map((row) => ({
      slot: row.slot,
      lane: row.slot,
      core: true,
      consumer: true,
      os: row.os,
      node: row.node,
    })),
    "attempt-runtime": runtime,
    "resource-release": runtime,
  });
});

test("repository workflow lint uses the same pinned checker before adapter acceptance", () => {
  assert.ok(
    [...workflows.keys()].every((name) => name.endsWith(".yml")),
    "The CI lint glob must cover every workflow extension",
  );
  const steps = workflows.get("ci.yml")!.jobs.actionlint!.steps;
  const prepare = steps.findIndex((step) =>
    step.run?.includes(
      "docker build --file scripts/actionlint-tools.Dockerfile",
    ),
  );
  const lint = steps.findIndex(
    (step) =>
      step.run ===
      'docker run --rm --network none --mount "type=bind,src=$GITHUB_WORKSPACE,target=/workspace,readonly" --workdir /workspace checktrail-actionlint-test:1.7.12 actionlint -config-file .github/actionlint.yaml -shellcheck= .github/workflows/*.yml',
  );
  const acceptance = steps.findIndex(
    (step) => step.run === "node scripts/verify-actionlint-container.mjs",
  );
  assert.ok(prepare >= 0 && lint > prepare && acceptance > lint);
  assert.equal(steps[lint]!["timeout-minutes"], 2);
});
