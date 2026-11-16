import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const { commandKey, validationPhases } = await import(
  new URL("../../scripts/ci-validation.mjs", import.meta.url).href
);
const { parseValidationShardArgs, selectValidationShard } = await import(
  new URL("../../scripts/ci-validation-shards.mjs", import.meta.url).href
);
type Row = { os: string; node: string; shard?: number };
type Step = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
};
type Job = {
  name?: string;
  if?: string;
  needs: string[];
  env?: Record<string, string>;
  "timeout-minutes": number;
  "continue-on-error"?: boolean;
  strategy: {
    "fail-fast": boolean;
    "max-parallel"?: number;
    matrix: { include: Row[] };
  };
  steps: Step[];
};
type Workflow = { jobs: Record<string, Job> };
type Context = {
  mode: "full" | "affected";
  hostValidation: "required" | "not-selected";
  plan: "success" | "failure" | "pending";
  actionlint: "success" | "skipped" | "failure" | "pending";
  cancelled: boolean;
};
const workflow = parse(
  await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
) as Workflow;
const manifest = JSON.parse(
  await readFile(
    new URL("../../scripts/ci-full-suite-profiles.json", import.meta.url),
    "utf8",
  ),
) as { schemaVersion: number; profiles: string[]; remainingCommands: string[] };
const variants = [
  { os: "ubuntu-latest", node: "22" },
  { os: "ubuntu-latest", node: "24" },
  { os: "ubuntu-latest", node: "26" },
  { os: "macos-latest", node: "24" },
];
const fullContext: Context = {
  mode: "full",
  hostValidation: "required",
  plan: "success",
  actionlint: "success",
  cancelled: false,
};
const hostCommand =
  "node scripts/run-ci-validation.mjs --shard${{ matrix.shard }}";
const fullCommand =
  "node scripts/verify-ci-full-suite-shard.mjs --shard${{ matrix.shard }}";
const reporter = "Verify current-root JavaScript compatibility";
const consumer = "node scripts/verify-consumer-impact-package.mjs";
const full0 = "node scripts/verify-ci-full-suite-shard.mjs --shard0";
const nativeRemainder =
  "node scripts/verify-required-native-tests.mjs tasks-runtime-manifest tasks-runtime-cli native-harness-cleanup tasks-runtime-startup go-installed-harness";
const mcpRemainder =
  "CHECKTRAIL_TEST_TASKS=1 node --test dist/test/mcp.test.js";
const reviewBuild =
  "docker build --file scripts/review-tools.Dockerfile --tag checktrail-review-tools:finish-first-v1 scripts";
const review = "node scripts/verify-review-container.mjs";
const taskStore = "node scripts/verify-task-store-container.mjs";
const taskMcp =
  "CHECKTRAIL_TASKS_IMAGE=docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 node scripts/verify-mcp-tasks-package.mjs";
const pulls = [
  "node scripts/pull-pinned-image.mjs docker.io/library/golang@sha256:ae5a2316d12f3e78fd99177dad452e6ad4f240af2d71d57b480c3477f250fec6",
  "node scripts/pull-pinned-image.mjs docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
];

// Interpret only the finite boolean/equality grammar these jobs use. This does
// not execute shell commands, workflow expressions, or general JavaScript.
function condition(expression: string | undefined, context: Context, row: Row) {
  if (expression === undefined) return true;
  let text = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/gu, "");
  const atoms: [string, boolean][] = [
    ["always()", true],
    ["cancelled()", context.cancelled],
    ["needs.ci-plan.result == 'success'", context.plan === "success"],
    [
      "fromJSON(needs.ci-plan.outputs.plan).mode == 'full'",
      context.mode === "full",
    ],
    [
      "fromJSON(needs.ci-plan.outputs.plan).mode == 'affected'",
      context.mode === "affected",
    ],
    [
      "fromJSON(needs.ci-plan.outputs.plan).hostValidation == 'required'",
      context.hostValidation === "required",
    ],
    ["env.CHECKTRAIL_CI_MODE == 'full'", context.mode === "full"],
    ["env.CHECKTRAIL_CI_MODE == 'affected'", context.mode === "affected"],
    ["runner.os == 'Linux'", row.os === "ubuntu-latest"],
    ["runner.os == 'macOS'", row.os === "macos-latest"],
    ["runner.os != 'macOS'", row.os !== "macos-latest"],
    ["matrix.os == 'ubuntu-latest'", row.os === "ubuntu-latest"],
    ["matrix.node == '22'", row.node === "22"],
    ["matrix.node == '26'", row.node === "26"],
    ["matrix.shard == 0", row.shard === 0],
    ["matrix.shard == 1", row.shard === 1],
    ["matrix.shard == 2", row.shard === 2],
  ];
  for (const [atom, value] of atoms)
    text = text.split(atom).join(String(value));
  const tokens = text.match(/true|false|&&|\|\||!|\(|\)/gu) ?? [];
  assert.equal(
    tokens.join(""),
    text.replace(/\s/gu, ""),
    "Unsupported CI condition",
  );
  let index = 0;
  function value(): boolean {
    const token = tokens[index++];
    if (token === "!") return !value();
    if (token === "(") {
      const result = or();
      assert.equal(tokens[index++], ")");
      return result;
    }
    assert.ok(
      token === "true" || token === "false",
      "Expected boolean CI atom",
    );
    return token === "true";
  }
  function and(): boolean {
    let result = value();
    while (tokens[index] === "&&") {
      index++;
      const right = value();
      result = result && right;
    }
    return result;
  }
  function or(): boolean {
    let result = and();
    while (tokens[index] === "||") {
      index++;
      const right = and();
      result = result || right;
    }
    return result;
  }
  const result = or();
  assert.equal(index, tokens.length);
  return result;
}
function ready(job: Job, context: Context, row: Row) {
  if (
    job.needs.some(
      (need) =>
        (need === "ci-plan" ? context.plan : context.actionlint) === "pending",
    )
  )
    return false;
  return condition(job.if, context, row);
}
function rows(w: Workflow, id: string, context: Context) {
  const job = w.jobs[id]!;
  return job.strategy.matrix.include.filter((row) => ready(job, context, row));
}
function lines(step: Step, context: Context, row: Row) {
  if (!condition(step.if, context, row)) return [];
  return (step.run ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      line
        .trim()
        .replace(
          /\$\{\{\s*matrix\.(os|node|shard)\s*\}\}/gu,
          (_, field: keyof Row) => String(row[field]),
        ),
    );
}
function executed(w: Workflow, id: string, context = fullContext) {
  const job = w.jobs[id]!;
  return rows(w, id, context).flatMap((row) =>
    job.steps.flatMap((step) =>
      lines(step, context, row).map((command) => ({ row, command })),
    ),
  );
}
function requireDurationWorkflow(w: Workflow) {
  const checks = w.jobs.checks!;
  const hosts = w.jobs["host-validation"]!;
  const extras = w.jobs["full-suite-shards"]!;
  assert.deepEqual(checks.strategy.matrix.include, variants);
  for (const [job, shards] of [
    [hosts, [0, 1, 2]],
    [extras, [1, 2]],
  ] as const) {
    assert.deepEqual(
      job.strategy.matrix.include,
      variants.flatMap((variant) =>
        shards.map((shard) => ({ ...variant, shard })),
      ),
    );
    assert.equal(job.strategy["max-parallel"], 8);
    assert.equal(job.strategy["fail-fast"], false);
    assert.deepEqual(job.needs, ["ci-plan", "actionlint"]);
    assert.equal(job["timeout-minutes"], 75);
    for (const field of ["os", "node", "shard"])
      assert.ok(job.name?.includes("matrix." + field));
  }
  assert.equal(
    hosts.steps.filter((step) => step.run === hostCommand).length,
    1,
  );
  assert.equal(
    extras.steps.filter((step) => step.run === fullCommand).length,
    1,
  );
  assert.equal(
    hosts.steps.find((step) => step.name === reporter)!.if,
    "matrix.shard == 0",
  );
  assert.equal(
    hosts.steps.find((step) => step.run === consumer)!.if,
    "matrix.shard == 0",
  );
  assert.ok(
    w.jobs["ci-complete"]!.needs.includes("full-suite-shards"),
    "Completion must require every full-suite shard",
  );
  for (const id of ["checks", "host-validation", "full-suite-shards"]) {
    assert.equal(w.jobs[id]!["continue-on-error"], undefined);
    assert.ok(
      w.jobs[id]!.steps.every(
        (step) => step["continue-on-error"] === undefined,
      ),
    );
  }
  assert.equal(extras.env?.CHECKTRAIL_CI_MODE, "full");
}

test("duration workflow freezes twelve host rows, eight extra suite rows and four original checks variants", () => {
  requireDurationWorkflow(workflow);
  assert.equal(rows(workflow, "host-validation", fullContext).length, 12);
  assert.equal(rows(workflow, "full-suite-shards", fullContext).length, 8);
  assert.equal(rows(workflow, "checks", fullContext).length, 4);
  assert.equal(
    workflow.jobs["host-validation"]!.strategy["max-parallel"]! +
      workflow.jobs["full-suite-shards"]!.strategy["max-parallel"]! +
      workflow.jobs.checks!.strategy.matrix.include.length,
    20,
  );
});

test("simulated dependency conditions keep full-only suite shards, affected host routing and the actionlint barrier", () => {
  const cases: [Partial<Context>, number, number, number][] = [
    [{}, 12, 8, 4],
    [{ mode: "affected", hostValidation: "required" }, 12, 0, 4],
    [{ mode: "affected", hostValidation: "not-selected" }, 0, 0, 4],
    [{ actionlint: "skipped" }, 12, 8, 4],
    [{ mode: "affected", actionlint: "skipped" }, 12, 0, 4],
    [{ actionlint: "pending" }, 0, 0, 4],
    [{ plan: "pending" }, 0, 0, 0],
    [{ plan: "failure" }, 0, 0, 0],
    [{ cancelled: true }, 0, 0, 0],
  ];
  for (const [changes, hostCount, extraCount, checksCount] of cases) {
    const context = { ...fullContext, ...changes };
    assert.equal(rows(workflow, "host-validation", context).length, hostCount);
    assert.equal(
      rows(workflow, "full-suite-shards", context).length,
      extraCount,
    );
    assert.equal(rows(workflow, "checks", context).length, checksCount);
  }
});

test("each host executes one exact 51-command union and one reporter and fresh consumer after preparation", () => {
  const hostJob = workflow.jobs["host-validation"]!;
  const cache = hostJob.steps.findIndex(
    (step) => step.run === "node scripts/prepare-package-cache.mjs",
  );
  const build = hostJob.steps.findIndex((step) => step.run === "npm run build");
  const report = hostJob.steps.findIndex((step) => step.name === reporter);
  const lane = hostJob.steps.findIndex((step) => step.run === hostCommand);
  const installed = hostJob.steps.findIndex((step) => step.run === consumer);
  assert.ok(
    build < cache && cache < report && report < lane && lane < installed,
  );
  for (const variant of variants) {
    const projected = executed(workflow, "host-validation").filter(
      ({ row }) => row.os === variant.os && row.node === variant.node,
    );
    const commands = projected.filter(({ command }) =>
      command.startsWith("node scripts/run-ci-validation.mjs "),
    );
    assert.equal(commands.length, 3);
    const assigned = commands.flatMap(({ command }) => {
      const shard = parseValidationShardArgs([command.split(" ").at(-1)]);
      return Object.values(selectValidationShard(shard).phases)
        .flat()
        .map(commandKey);
    });
    const expected = Object.values(validationPhases)
      .flat()
      .map(commandKey)
      .sort();
    assert.equal(assigned.length, 51);
    assert.equal(new Set(assigned).size, 51);
    assert.deepEqual(assigned.sort(), expected);
    assert.equal(
      projected.filter(({ command }) => command === consumer).length,
      1,
    );
    assert.equal(
      projected.filter(
        ({ command }) =>
          command === "node scripts/verify-root-javascript-reporters.mjs",
      ).length,
      1,
    );
  }
});

test("each original host retains all three full-suite roles and both remaining commands exactly once", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profiles.length, 73);
  assert.equal(new Set(manifest.profiles).size, 73);
  assert.deepEqual(manifest.remainingCommands, [nativeRemainder, mcpRemainder]);
  const commands = [
    ...executed(workflow, "checks"),
    ...executed(workflow, "full-suite-shards"),
  ];
  for (const variant of variants) {
    const projected = commands
      .filter(({ row }) => row.os === variant.os && row.node === variant.node)
      .map(({ command }) => command);
    const roles = projected
      .flatMap((command) => {
        const match =
          /^node scripts\/verify-ci-full-suite-shard\.mjs --shard([0-2])$/u.exec(
            command,
          );
        return match ? [Number(match[1])] : [];
      })
      .sort();
    assert.deepEqual(roles, [0, 1, 2]);
    assert.equal(
      projected.filter((command) => command === nativeRemainder).length,
      1,
    );
    assert.equal(
      projected.filter((command) => command === mcpRemainder).length,
      1,
    );
    assert.equal(projected.filter((command) => command === full0).length, 1);
  }
});

test("extra suite rows retain every SDK preparation and browser bound while checks retain once-only audits and controls", () => {
  const checks = workflow.jobs.checks!;
  const extras = workflow.jobs["full-suite-shards"]!;
  const guard = checks.steps.findIndex(
    (step) => step.run === "node scripts/verify-consumer-impact-guards.mjs",
  );
  const proof = extras.steps.findIndex((step) => step.run === fullCommand);
  const removedRepeats = new Set([
    "npm run typecheck",
    "npm run lint",
    "node scripts/audit-dependencies.mjs",
    "npm run format:check",
  ]);
  const preparation = checks.steps
    .slice(0, guard)
    .filter((step) => !removedRepeats.has(step.run ?? ""));
  assert.deepEqual(extras.steps.slice(0, proof), preparation);
  const hosts = workflow.jobs["host-validation"]!;
  const hostCache = hosts.steps.findIndex(
    (step) => step.run === "node scripts/prepare-package-cache.mjs",
  );
  assert.ok(hostCache > 0);
  const projectedPreparation = (steps: Step[], row: Row) =>
    steps
      .filter((step) => condition(step.if, fullContext, row))
      .map((step) =>
        Object.fromEntries(
          Object.entries(step).filter(([key]) => key !== "if"),
        ),
      );
  for (const variant of variants)
    for (const shard of [0, 1, 2])
      assert.deepEqual(
        projectedPreparation(hosts.steps.slice(0, hostCache), {
          ...variant,
          shard,
        }),
        projectedPreparation(preparation, { ...variant, shard }),
        "Every host shard must receive the same complete prepared toolchains",
      );
  assert.ok(!extras.steps.some((step) => removedRepeats.has(step.run ?? "")));
  assert.equal(
    extras.steps.find(
      (step) =>
        step.name === "Prepare pinned Chromium for native browser fixtures",
    )!["timeout-minutes"],
    10,
  );
  for (const command of [
    "node scripts/audit-gate-inventory.mjs .",
    "node scripts/verify-evaluation-protocol-package.mjs --metering",
    nativeRemainder,
    mcpRemainder,
  ]) {
    assert.equal(
      executed(workflow, "checks").filter((entry) => entry.command === command)
        .length,
      4,
    );
    assert.equal(
      executed(workflow, "full-suite-shards").filter(
        (entry) => entry.command === command,
      ).length,
      0,
    );
  }
  assert.equal(
    executed(workflow, "checks").filter(
      (entry) =>
        entry.command === "node scripts/verify-consumer-impact-guards.mjs",
    ).length,
    1,
  );
});

test("Linux container work moves once to its designated suite role with both cache and exact image preparation", () => {
  const extras = workflow.jobs["full-suite-shards"]!;
  const commands = executed(workflow, "full-suite-shards");
  for (const [command, shard] of [
    [reviewBuild, 1],
    [review, 1],
    [taskStore, 2],
    [taskMcp, 2],
  ] as const) {
    assert.deepEqual(
      commands
        .filter((entry) => entry.command === command)
        .map(({ row }) => row),
      [{ os: "ubuntu-latest", node: "22", shard }],
    );
    assert.equal(
      executed(workflow, "checks").filter((entry) => entry.command === command)
        .length,
      0,
    );
  }
  for (const shard of [1, 2]) {
    const row = { os: "ubuntu-latest", node: "22", shard };
    const projected = extras.steps.flatMap((step) =>
      lines(step, fullContext, row),
    );
    const cache = projected.indexOf("node scripts/prepare-package-cache.mjs");
    assert.ok(cache >= 0);
    for (const pull of pulls) assert.ok(projected.indexOf(pull) > cache);
    for (const command of shard === 1
      ? [reviewBuild, review]
      : [taskStore, taskMcp])
      assert.ok(projected.indexOf(command) > projected.indexOf(pulls[1]!));
  }
});

test("workflow guard rejects missing or moved roles, dropped completion dependency and bypassed shard failures", () => {
  const mutations: ((changed: Workflow) => void)[] = [
    (w) => {
      w.jobs["host-validation"]!.strategy.matrix.include.pop();
    },
    (w) => {
      w.jobs["full-suite-shards"]!.strategy.matrix.include[0]!.shard = 0;
    },
    (w) => {
      w.jobs["ci-complete"]!.needs = w.jobs["ci-complete"]!.needs.filter(
        (id) => id !== "full-suite-shards",
      );
    },
    (w) => {
      w.jobs["host-validation"]!["continue-on-error"] = true;
    },
    (w) => {
      w.jobs["full-suite-shards"]!.steps.find(
        (step) => step.run === fullCommand,
      )!["continue-on-error"] = true;
    },
    (w) => {
      delete w.jobs["host-validation"]!.steps.find(
        (step) => step.run === consumer,
      )!.if;
    },
  ];
  for (const mutate of mutations) {
    const changed = globalThis.structuredClone(workflow);
    mutate(changed);
    assert.throws(() => requireDurationWorkflow(changed));
  }
});
