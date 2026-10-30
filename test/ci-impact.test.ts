import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixture } from "./helpers.js";
const {
  buildNativeInputs,
  acceptFullBaseline,
  requestFullBaselineJobs,
  requestFullBaselineChecks,
  acceptFullBaselineChecks,
  workflowJobNames,
  nativeJobIds,
  planNativeJobs,
  requireCiCompletion,
  validateInputContract,
} = await import(new URL("../../scripts/ci-impact.mjs", import.meta.url).href);
const root = new URL("../../", import.meta.url);
const workflow = parse(
  await readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
);
const inputs = JSON.parse(
  await readFile(new URL("scripts/ci-native-inputs.json", root), "utf8"),
);
const jobs = nativeJobIds(workflow);
const baseline = {
  complete: true,
  commit: "a".repeat(40),
  run: "https://github.com/example/project/actions/runs/1",
  jobs: 81,
};
const plan = (changed: string[], options: Record<string, unknown> = {}) =>
  planNativeJobs({
    jobs,
    inputs,
    changed,
    baseline,
    eventName: "pull_request",
    ...options,
  });
const selected = (result: ReturnType<typeof plan>) =>
  Object.keys(result.selected).filter((id) => result.selected[id]);
test("CI declared native inputs match every workflow controller profile matrix and imported fixture", async () => {
  // Git inventory plus new unignored files makes this check work before commit.
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const actual = await buildNativeInputs({
    workflow,
    requirements: JSON.parse(
      await readFile(
        new URL("scripts/required-native-tests.json", root),
        "utf8",
      ),
    ),
    files,
    readText: (file: string) => readFile(new URL(file, root), "utf8"),
  });
  assert.deepEqual(actual, inputs);
  validateInputContract(inputs, jobs);
  assert.deepEqual(selected(plan(["test/gate-scala-extensions.test.ts"])), [
    "scala-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/scala-extensions-fixture.ts"])), [
    "scala-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-context-csharp.test.ts"])), [
    "csharp-context-arm64",
  ]);
  assert.deepEqual(selected(plan(["scripts/fsharp-format-tools.Dockerfile"])), [
    "dotnet-format-extensions-arm64",
    "dotnet-generator-extensions-arm64",
    "fsharp-format-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-ruby-extensions.test.ts"])), [
    "ruby-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/ruby-extensions-fixture.ts"])), [
    "ruby-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["scripts/ruby-tools.Dockerfile"])), [
    "ruby-extensions-arm64",
    "ruby-tools",
  ]);
  assert.deepEqual(selected(plan(["test/gate-swift-extensions.test.ts"])), [
    "swift-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/swift-extensions-fixture.ts"])), [
    "swift-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-cpp-extensions.test.ts"])), [
    "cpp-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/cpp-extensions-fixture.ts"])), [
    "cpp-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-terraform-extensions.test.ts"])), [
    "terraform-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/terraform-extensions-fixture.ts"])), [
    "terraform-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-helm-extensions.test.ts"])), [
    "helm-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/helm-extensions-fixture.ts"])), [
    "helm-extensions-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/gate-mutation-runners.test.ts"])), [
    "mutation-native-arm64",
  ]);
  assert.deepEqual(selected(plan(["test/mutation-native-fixture.ts"])), [
    "mutation-native-arm64",
    "mutation-passive-guards",
  ]);
  for (const file of [
    "test/mutation-native-evidence.test.ts",
    "test/mutation-native-copy.test.ts",
    "test/mutation-native-guards.test.ts",
    "test/mutation-native-selection.test.ts",
  ])
    assert.deepEqual(selected(plan([file])), ["mutation-passive-guards"]);
  assert.ok(inputs["test/dotnet-build.test.ts"].includes("dotnet"));
  for (const entry of workflow.jobs.dotnet.strategy.matrix.include)
    assert.ok(inputs["scripts/" + entry.script].includes("dotnet"));
  for (const member of workflow.jobs["ruby-tools"].strategy.matrix.profile) {
    const requirements = JSON.parse(
      await readFile(
        new URL("scripts/required-native-tests.json", root),
        "utf8",
      ),
    );
    for (const item of requirements[member])
      assert.ok(
        inputs[item.file.slice(5).replace(/\.js$/, ".ts")].includes(
          "ruby-tools",
        ),
      );
  }
});
test("CI Tasks runtime jobs participate in selection and the final completion inventory", () => {
  for (const id of ["tasks-runtime", "tasks-runtime-arm64"]) {
    assert.deepEqual(workflow.jobs[id].needs, ["ci-plan", "actionlint"]);
    assert.equal(
      workflow.jobs[id].if,
      "${{ always() && !cancelled() && (needs.ci-plan.result != 'success' || fromJSON(needs.ci-plan.outputs.plan).selected['" +
        id +
        "']) }}",
    );
    assert.ok(workflow.jobs["ci-complete"].needs.includes(id));
    assert.equal(plan(["test/gate-tasks-matrix.test.ts"]).selected[id], true);
  }
});

test("CI image delivery addresses do not expand native callback owners while explicit controller profiles still do", async () => {
  const families = ["python", "rust", "swift"];
  const actual = await buildNativeInputs({
    workflow: {
      jobs: {
        delivery: {
          steps: [
            {
              run:
                "node scripts/pull-pinned-image.mjs docker.io/library/python@sha256:" +
                "a".repeat(64),
            },
          ],
        },
        validation: {
          steps: [{ run: "node scripts/native-controller.mjs" }],
        },
        adjacent: {
          steps: [
            {
              run:
                "docker run public.ecr.aws/docker/library/rust@sha256:" +
                "b".repeat(64) +
                " node scripts/verify-required-native-tests.mjs swift",
            },
          ],
        },
      },
    },
    requirements: Object.fromEntries(
      families.map((name) => [
        name,
        [{ file: "dist/test/" + name + "-native.test.js" }],
      ]),
    ),
    files: [
      "scripts/pull-pinned-image.mjs",
      "scripts/native-controller.mjs",
      ...families.map((name) => "test/" + name + "-native.test.ts"),
    ],
    readText: (file: string) =>
      file === "scripts/pull-pinned-image.mjs"
        ? readFile(new URL(file, root), "utf8")
        : Promise.resolve(
            "node scripts/verify-required-native-tests.mjs python",
          ),
  });
  assert.deepEqual(actual["scripts/pull-pinned-image.mjs"], ["delivery"]);
  assert.deepEqual(actual["test/python-native.test.ts"], ["validation"]);
  assert.deepEqual(actual["test/swift-native.test.ts"], ["adjacent"]);
  assert.equal(Object.hasOwn(actual, "test/rust-native.test.ts"), false);
});

test("CI selection unions exact native owners and keeps unclassified near misses global", () => {
  assert.deepEqual(
    selected(
      plan([
        "test/gate-context-csharp.test.ts",
        "test/gate-scala-extensions.test.ts",
      ]),
    ),
    ["csharp-context-arm64", "scala-extensions-arm64"],
  );
  for (const file of [
    "test/gate-context-csharp.test.ts.backup",
    "test/new-language.test.ts",
    "src/review-csharp-resolution.ts",
    "schemas/report.schema.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "scripts/required-native-tests.json",
    "docs/required-inventory.json",
    "docs/gate-a-profiles.v1.json",
    "test/deleted-old-fixture.ts",
  ]) {
    const result = plan([file]);
    assert.equal(result.mode, "full", file);
    assert.deepEqual(selected(result), jobs);
  }
  assert.equal(plan(["README.md", "docs/NATIVE-CI.md"]).mode, "affected");
  assert.deepEqual(selected(plan(["README.md", "docs/NATIVE-CI.md"])), []);
});
test("CI native input traversal retains exact documentation data consumers", async () => {
  const file =
    "docs/measurements/artifact-identities-2026-10-21/native-input.json";
  const actual = await buildNativeInputs({
    workflow: {
      jobs: {
        native: { steps: [{ run: "node scripts/native-controller.mjs" }] },
      },
    },
    requirements: {},
    files: [
      "scripts/native-controller.mjs",
      file,
      "docs/gate-a-profiles.v1.json",
    ],
    readText: () =>
      Promise.resolve(
        `readFile("${file}"); readFile("docs/gate-a-profiles.v1.json")`,
      ),
  });
  assert.deepEqual(actual[file], ["native"]);
  assert.equal(Object.hasOwn(actual, "docs/gate-a-profiles.v1.json"), false);
  const result = planNativeJobs({
    jobs: ["native"],
    inputs: actual,
    changed: [file],
    eventName: "pull_request",
    sourceBoundaries: [],
  });
  assert.deepEqual(result.selected, { native: true });
  assert.ok(
    result.sharedTestFiles.includes("dist/test/artifact-evidence.test.js"),
  );
});
test("CI retained artifact data requires whole shared audits without unrelated native stacks and preserves native consumers", () => {
  const directory = "docs/measurements/artifact-identities-2026-10-21/";
  const artifactFile = "dist/test/artifact-evidence.test.js";
  for (const file of [
    "README.md",
    "artifact-evidence-index.v1.json",
    "provider-fiat-wrapper-source-rebuilds.json",
    "provider-compiler-inputs/fiat-producer-chain-original-notices.txt",
    "new-record.json",
  ]) {
    const result = plan([directory + file]);
    assert.equal(result.mode, "affected", file);
    assert.deepEqual(selected(result), [], file);
    assert.ok(result.sharedTestFiles.includes(artifactFile), file);
  }
  assert.ok(plan(["README.md"]).sharedTestFiles.includes(artifactFile));
  for (const file of [
    directory.slice(0, -1) + "0/record.json",
    directory.slice(0, -1),
    directory + "../record.json",
    "docs/measurements/other/record.json",
    "scripts/ci-impact.mjs",
    "scripts/verify-ci-affected-tests.mjs",
  ]) {
    assert.equal(plan([file]).mode, "full", file);
  }
  const data = directory + "README.md";
  const combined = plan([data, "test/gate-scala-extensions.test.ts"], {
    inputs: { ...inputs, [data]: ["csharp-context-arm64"] },
  });
  assert.deepEqual(selected(combined), [
    "csharp-context-arm64",
    "scala-extensions-arm64",
  ]);
  assert.ok(combined.sharedTestFiles.includes(artifactFile));
});
test("CI stale contracts and non-PR events select the complete inventory while missing history does not broaden known PR inputs", () => {
  for (const baseline of [null, { complete: false }]) {
    const result = plan(["test/gate-scala-extensions.test.ts"], { baseline });
    assert.deepEqual(selected(result), ["scala-extensions-arm64"]);
    assert.equal(result.baseline, null);
    assert.ok(
      result.sharedTestFiles.includes(
        "dist/test/gate-scala-extensions.test.js",
      ),
    );
    assert.ok(
      !result.sharedTestFiles.includes("dist/test/gate-context-csharp.test.js"),
    );
  }
  for (const options of [
    { contractCurrent: false },
    { eventName: "push" },
    { eventName: "schedule" },
    { eventName: "workflow_dispatch" },
  ])
    assert.deepEqual(
      selected(plan(["test/gate-scala-extensions.test.ts"], options)),
      jobs,
    );
  for (const changed of [
    [],
    ["../outside"],
    ["/absolute"],
    Array(10001).fill("README.md"),
  ])
    assert.deepEqual(selected(plan(changed)), jobs);
  const unknown = structuredClone(inputs);
  unknown["test/gate-scala-extensions.test.ts"] = ["unknown-job"];
  assert.throws(
    () => validateInputContract(unknown, jobs),
    /Unknown CI input owner/,
  );
});
test("CI completion requires selected jobs to pass and reports omitted jobs as unselected", () => {
  const result = plan(["test/gate-scala-extensions.test.ts"]);
  const needs = Object.fromEntries(
    ["ci-plan", "checks", "host-validation", ...jobs].map((id) => [
      id,
      {
        result:
          id === "scala-extensions-arm64" || ["ci-plan", "checks"].includes(id)
            ? "success"
            : "skipped",
      },
    ]),
  );
  const receipt = requireCiCompletion(result, needs);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.selectedNativeJobs, ["scala-extensions-arm64"]);
  assert.ok(receipt.notSelectedNativeJobs.includes("jvm-wrappers-arm64"));
  for (const id of ["ci-plan", "checks", "scala-extensions-arm64"])
    for (const status of ["failure", "cancelled", "skipped"]) {
      const broken = structuredClone(needs);
      broken[id].result = status;
      assert.throws(
        () => requireCiCompletion(result, broken),
        /outcome disagrees/,
      );
    }
  const missing = structuredClone(needs);
  delete missing["scala-extensions-arm64"];
  assert.throws(
    () => requireCiCompletion(result, missing),
    /inventory differs/,
  );
  const falseBaseline = { ...result, baseline: null };
  const withoutBaseline = requireCiCompletion(falseBaseline, needs);
  assert.equal(withoutBaseline.fullRevisionVerification, false);
  assert.equal(withoutBaseline.omittedJobsQualified, false);
  const unnecessaryHost = structuredClone(needs);
  unnecessaryHost["host-validation"].result = "success";
  assert.throws(
    () => requireCiCompletion(result, unnecessaryHost),
    /outcome disagrees/,
  );
  assert.throws(
    () => requireCiCompletion({ ...result, mode: "full" }, needs),
    /cannot omit/,
  );
  const unexpected = structuredClone(needs);
  unexpected["jvm-wrappers-arm64"].result = "success";
  assert.throws(
    () => requireCiCompletion(result, unexpected),
    /outcome disagrees/,
  );
});
test("CI managed pull-request branch prefixes avoid duplicate push workflows while tags retain verification", () => {
  assert.deepEqual(workflow.on.push["branches-ignore"], [
    "pr/**",
    "dependabot/**",
    "fix/**",
  ]);
  assert.deepEqual(workflow.on.push.tags, ["**"]);
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
});

test("CI initial wave stays within the free runner ceiling and selected jobs survive admission failure or skip", () => {
  const variants = (job: {
    strategy?: { matrix?: Record<string, unknown[]> };
  }) => {
    const matrix = job.strategy?.matrix;
    return !matrix
      ? 1
      : matrix.include
        ? matrix.include.length
        : Object.values(matrix).reduce((n, values) => n * values.length, 1);
  };
  const initial = Object.entries(workflow.jobs).filter(
    ([id, job]) =>
      id !== "ci-complete" &&
      !(job as { needs?: string[] }).needs?.includes("actionlint"),
  );
  const initialJobs = initial.reduce(
    (n, [, job]) => n + variants(job as Parameters<typeof variants>[0]),
    0,
  );
  assert.ok(
    initialJobs > 0 && initialJobs <= 20,
    "Initial CI wave exceeds the free runner ceiling",
  );
  assert.deepEqual(workflow.jobs["jvm-wrappers-arm64"].needs, [
    "ci-plan",
    "actionlint",
  ]);
  for (const id of jobs) {
    const job = workflow.jobs[id];
    assert.ok(job.needs.includes("ci-plan"));
    assert.ok(job.if.includes("always() && !cancelled()"));
    assert.ok(job.if.includes("needs.ci-plan.result != 'success'"));
    assert.ok(job.if.includes("selected['" + id + "']"));
  }
  assert.deepEqual(
    workflow.jobs["ci-complete"].needs.toSorted(),
    ["ci-plan", "checks", "host-validation", ...jobs].sort(),
  );
  assert.deepEqual(workflow.jobs["dotnet-generator-extensions-arm64"].needs, [
    "ci-plan",
  ]);
  assert.deepEqual(workflow.jobs["fsharp-format-arm64"].needs, [
    "ci-plan",
    "actionlint",
  ]);
  assert.equal(workflow.jobs["ci-complete"].if, "${{ always() }}");
  assert.ok(workflow.on.schedule.length > 0);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
});

test("CI exact-base evidence rejects incomplete failed skipped duplicate wrong-commit and wrong-job runs", () => {
  const expectedNames = workflowJobNames(workflow);
  const run = {
    id: 1,
    head_sha: baseline.commit,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: baseline.run,
  };
  const result = {
    total_count: expectedNames.length,
    jobs: expectedNames.map((name: string, i: number) => ({
      id: i + 1,
      run_id: 1,
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  assert.deepEqual(
    acceptFullBaseline(run, result, { base: baseline.commit, expectedNames }),
    { ...baseline, jobs: expectedNames.length },
  );
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { head_branch: "other" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
  ])
    assert.equal(
      acceptFullBaseline({ ...run, ...patch }, result, {
        base: baseline.commit,
        expectedNames,
      }),
      null,
    );
  for (const patch of [
    { run_id: 2 },
    { name: "different-job" },
    { status: "in_progress" },
    { conclusion: "skipped" },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
  ]) {
    const wrong = structuredClone(result);
    Object.assign(wrong.jobs[0]!, patch);
    assert.equal(
      acceptFullBaseline(run, wrong, { base: baseline.commit, expectedNames }),
      null,
    );
  }
  const short = structuredClone(result);
  short.jobs.pop();
  assert.equal(
    acceptFullBaseline(run, short, { base: baseline.commit, expectedNames }),
    null,
  );
  const duplicate = structuredClone(result);
  duplicate.jobs[1] = duplicate.jobs[0]!;
  assert.equal(
    acceptFullBaseline(run, duplicate, {
      base: baseline.commit,
      expectedNames,
    }),
    null,
  );
  assert.equal(
    acceptFullBaseline(
      run,
      { total_count: 0, jobs: [] },
      { base: baseline.commit, expectedNames },
    ),
    null,
  );
});

test("CI a successful pre-split JVM baseline cannot qualify the expanded phase inventory", () => {
  const previous = structuredClone(workflow);
  delete previous.jobs["jvm-wrappers-arm64"].strategy;
  const priorNames = workflowJobNames(previous);
  const expectedNames = workflowJobNames(workflow);
  assert.equal(expectedNames.length, priorNames.length + 2);
  assert.ok(priorNames.includes("jvm-wrappers-arm64"));
  for (const phase of ["baseline", "acceptance", "guards-regressions"])
    assert.ok(expectedNames.includes("jvm-wrappers-arm64 (" + phase + ")"));
  const run = {
    id: 1,
    head_sha: baseline.commit,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: baseline.run,
  };
  const result = {
    total_count: priorNames.length,
    jobs: priorNames.map((name: string, index: number) => ({
      id: index + 1,
      run_id: 1,
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  assert.equal(
    acceptFullBaseline(run, result, { base: baseline.commit, expectedNames }),
    null,
  );
  assert.deepEqual(selected(plan(["test/jvm-wrapper-phases.test.ts"])), [
    "jvm-wrappers-arm64",
  ]);
  assert.deepEqual(
    selected(plan(["scripts/jvm-wrapper-phase-evidence.mjs"])),
    jobs,
  );
});

test("CI split matrix retains each runner's package cache before Linux installed-container acceptance", () => {
  const steps = workflow.jobs.checks.steps;
  const cache = steps.findIndex(
    (step: { run?: string }) =>
      step.run === "node scripts/prepare-package-cache.mjs",
  );
  assert.ok(cache >= 0);
  assert.equal(
    steps[cache].if,
    "env.CHECKTRAIL_CI_MODE == 'full' && (matrix.os == 'ubuntu-latest' && matrix.node == '22')",
  );
  for (const script of [
    "verify-review-container.mjs",
    "verify-task-store-container.mjs",
  ])
    assert.ok(
      steps.findIndex(
        (step: { run?: string }) => step.run === "node scripts/" + script,
      ) > cache,
    );
  assert.equal(
    workflow.jobs["host-validation"].steps.filter(
      (step: { run?: string }) =>
        step.run === "node scripts/prepare-package-cache.mjs",
    ).length,
    1,
  );
});

test("CI full baseline pagination admits every declared job across page boundaries in one run attempt", async () => {
  for (const count of [1, 100, 101, 205]) {
    const expectedNames = Array.from(
      { length: count },
      (_, i) => "job-" + String(i).padStart(3, "0"),
    );
    const run = {
      id: 1,
      head_sha: baseline.commit,
      head_branch: "main",
      event: "push",
      status: "completed",
      conclusion: "success",
      html_url: baseline.run,
    };
    const jobs = expectedNames.map((name, i) => ({
      id: i + 1,
      run_id: 1,
      name,
      status: "completed",
      conclusion: "success",
    }));
    const endpoint =
      "https://api.github.com/repos/example/project/actions/runs/1/attempts/2/jobs";
    const requests: string[] = [];
    const receipt = await requestFullBaselineJobs(
      async (url: string) => {
        requests.push(url);
        const page = requests.length;
        return {
          total_count: count,
          jobs: jobs.slice((page - 1) * 100, page * 100),
        };
      },
      endpoint,
      count,
    );
    assert.deepEqual(
      requests,
      Array.from(
        { length: Math.ceil(count / 100) },
        (_, i) => endpoint + "?per_page=100&page=" + (i + 1),
      ),
    );
    assert.deepEqual(
      acceptFullBaseline(run, receipt, {
        base: baseline.commit,
        expectedNames,
      }),
      { ...baseline, jobs: count },
    );
    if (count > 100)
      assert.equal(
        acceptFullBaseline(
          run,
          { total_count: count, jobs: jobs.slice(0, 100) },
          { base: baseline.commit, expectedNames },
        ),
        null,
      );
  }
});

test("CI full baseline pagination rejects missing changing duplicate and malformed continuation pages", async () => {
  const jobs = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
  for (const bad of [
    { total_count: 101, jobs: [] },
    { total_count: 102, jobs: jobs.slice(100) },
    { total_count: 101, jobs: jobs.slice(0, 1) },
    { total_count: 101, jobs: null },
  ]) {
    const requests: string[] = [];
    await assert.rejects(
      requestFullBaselineJobs(
        async (url: string) => {
          requests.push(url);
          return requests.length === 1
            ? { total_count: 101, jobs: jobs.slice(0, 100) }
            : bad;
        },
        "attempt-jobs",
        101,
      ),
      /Baseline job|Duplicate baseline/,
    );
    assert.equal(requests.length, 2);
  }
  for (const count of [0, 1.5, 1001]) {
    let requested = false;
    await assert.rejects(
      requestFullBaselineJobs(
        async () => {
          requested = true;
        },
        "attempt-jobs",
        count,
      ),
      /bounded pagination/,
    );
    assert.equal(requested, false);
  }
});

test("CI passive mutation guard receipt labels do not select native cohorts while explicit invocations still do", async () => {
  const actual = await buildNativeInputs({
    workflow: {
      jobs: {
        passive: {
          steps: [{ run: "node scripts/verify-mutation-guards.mjs passive" }],
        },
        native: {
          steps: [
            {
              run: "node scripts/verify-required-native-tests.mjs mutation-vitest",
            },
          ],
        },
      },
    },
    requirements: {
      "mutation-runners": [{ file: "dist/test/native-cohort.test.js" }],
      "mutation-vitest": [{ file: "dist/test/native-cohort.test.js" }],
    },
    files: [
      "scripts/verify-mutation-guards.mjs",
      "scripts/verify-required-native-tests.mjs",
      "test/native-cohort.test.ts",
      "test/passive-cohort.test.ts",
    ],
    readText: (file: string) =>
      Promise.resolve(
        file === "scripts/verify-mutation-guards.mjs"
          ? 'import "../test/passive-cohort.test.js"; const receipt = {profile: "mutation-runners"};'
          : "",
      ),
  });
  assert.deepEqual(actual["test/passive-cohort.test.ts"], ["passive"]);
  assert.deepEqual(actual["test/native-cohort.test.ts"], ["native"]);
});

test("CI planner accepts reordered ownership objects and still rejects changed ownership", async (t) => {
  const reversed = Object.fromEntries(Object.entries(inputs).reverse());
  assert.deepEqual(reversed, inputs);
  assert.notEqual(JSON.stringify(reversed), JSON.stringify(inputs));
  const altered = structuredClone(inputs) as Record<string, string[]>;
  const changed = Object.keys(altered).find(
    (file) => altered[file]!.length < jobs.length,
  )!;
  const extra = jobs.find((id: string) => !altered[changed]!.includes(id))!;
  altered[changed] = [...altered[changed]!, extra].sort();
  const base = "a".repeat(40);
  const run = {
    id: 17,
    run_attempt: 1,
    head_sha: base,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/project/actions/runs/17",
  };
  const names = workflowJobNames(workflow);
  const baselineJobs = names.map((name: string, index: number) => ({
    id: index + 1,
    run_id: run.id,
    name,
    status: "completed",
    conclusion: "success",
  }));
  const directory = await fixture(t, {
    "event.json": JSON.stringify({
      pull_request: { base: { sha: base }, head: { sha: "b".repeat(40) } },
    }),
    output: "",
    summary: "",
  });
  for (const [variant, contract, expectedMode] of [
    ["reordered", reversed, "affected"],
    ["changed", altered, "full"],
  ] as const) {
    const loader = path.join(directory, variant + ".mjs");
    const marker = path.join(directory, variant + ".json");
    await writeFile(
      loader,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import child from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const contract = ${JSON.stringify(contract)};
const run = ${JSON.stringify(run)};
const jobs = ${JSON.stringify(baselineJobs)};
const counts = {contractReads:0,diffCalls:0,apiCalls:0};
const originalRead = fs.promises.readFile;
fs.promises.readFile = async (...args) => {
  if(args[0] === "scripts/ci-native-inputs.json") { counts.contractReads++;return JSON.stringify(contract); }
  return originalRead(...args);
};
const originalExec = child.execFileSync;
child.execFileSync = (executable,args,...options) => {
  if(executable === "git" && args[0] === "diff") { counts.diffCalls++;return "docs/README.md"+String.fromCharCode(0); }
  return originalExec(executable,args,...options);
};
syncBuiltinESMExports();
globalThis.fetch = async (address, options) => {
  counts.apiCalls++;
  assert.equal(options.headers.Authorization,"Bearer synthetic-token");
  const url = new URL(address);
  assert.equal(url.origin,"https://api.github.com");
  let body;
  if(url.pathname === "/repos/example/project/actions/workflows/ci.yml/runs") {
    assert.equal(url.searchParams.get("head_sha"),run.head_sha);
    body={workflow_runs:[run]};
  } else {
    assert.equal(url.pathname,"/repos/example/project/actions/runs/17/attempts/1/jobs");
    assert.equal(url.searchParams.get("per_page"),"100");
    const page=Number(url.searchParams.get("page"));assert.ok(page>=1 && page<=Math.ceil(jobs.length/100));
    body={total_count:jobs.length,jobs:jobs.slice((page-1)*100,page*100)};
  }
  return new Response(JSON.stringify(body),{status:200});
};
process.on("exit",()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(counts)));
`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/project",
      GITHUB_TOKEN: "synthetic-token",
      GITHUB_EVENT_PATH: path.join(directory, "event.json"),
      GITHUB_OUTPUT: path.join(directory, "output"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    };
    delete env.NODE_TEST_CONTEXT;
    env.CHECKTRAIL_CI_OBSERVE_BASELINE = "1";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        fileURLToPath(new URL("scripts/plan-ci-impact.mjs", root)),
      ],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.mode, expectedMode, variant + ": " + actual.reason);
    const observed = JSON.parse(await readFile(marker, "utf8"));
    assert.equal(observed.contractReads, 1);
    if (variant === "reordered") {
      assert.deepEqual(selected(actual), []);
      assert.equal(actual.baseline.commit, base);
      assert.equal(observed.diffCalls, 1);
      assert.equal(observed.apiCalls, 1 + Math.ceil(names.length / 100));
    } else {
      assert.deepEqual(selected(actual), jobs);
      assert.match(actual.reason, /contract changed or is stale/);
      assert.equal(observed.diffCalls, 0);
      assert.equal(observed.apiCalls, 0);
    }
  }
});

test("CI Checks fallback requires the complete exact Actions suite and an unchanged successful run", () => {
  const expectedNames = workflowJobNames(workflow);
  const run = {
    id: 17,
    run_attempt: 2,
    check_suite_id: 27,
    head_sha: baseline.commit,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/project/actions/runs/17",
  };
  const checks = expectedNames.map((name: string, index: number) => ({
    id: index + 1,
    head_sha: baseline.commit,
    check_suite: { id: 27 },
    app: { id: 15368, slug: "github-actions" },
    details_url: run.html_url + "/job/" + (index + 1001),
    name,
    status: "completed",
    conclusion: "success",
  }));
  const result = { total_count: checks.length, check_runs: checks };
  const options = {
    base: baseline.commit,
    expectedNames,
    repository: "example/project",
    observedRun: { ...run },
  };
  assert.deepEqual(acceptFullBaselineChecks(run, result, options), {
    ...baseline,
    run: run.html_url,
    jobs: checks.length,
  });
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { head_branch: "elsewhere" },
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { run_attempt: 3 },
    { check_suite_id: 28 },
    { html_url: "https://github.com/foreign/project/actions/runs/17" },
  ]) {
    assert.equal(
      acceptFullBaselineChecks(run, result, {
        ...options,
        observedRun: { ...run, ...patch },
      }),
      null,
    );
    assert.equal(
      acceptFullBaselineChecks({ ...run, ...patch }, result, options),
      null,
    );
  }
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { check_suite: { id: 28 } },
    { app: { id: 1, slug: "github-actions" } },
    { app: { id: 15368, slug: "foreign-app" } },
    { details_url: run.html_url + "/job/0" },
    { details_url: run.html_url + "/job/01" },
    { details_url: run.html_url + "/job/9007199254740992" },
    { details_url: run.html_url + "/job/123?other=1" },
    { details_url: run.html_url + "/job/123/extra" },
    {
      details_url: "https://github.com/foreign/project/actions/runs/17/job/123",
    },
    { details_url: run.html_url.replace("/17", "/18") + "/job/123" },
    { id: 0 },
    { id: 1.5 },
    { name: expectedNames[1] },
    { status: "in_progress" },
    { conclusion: "skipped" },
    { conclusion: "cancelled" },
    { conclusion: "failure" },
  ]) {
    const changed = structuredClone(result);
    Object.assign(changed.check_runs[0]!, patch);
    assert.equal(
      acceptFullBaselineChecks(run, changed, options),
      null,
      JSON.stringify(patch),
    );
  }
  const duplicateJob = structuredClone(result);
  duplicateJob.check_runs[1]!.details_url =
    duplicateJob.check_runs[0]!.details_url;
  assert.equal(acceptFullBaselineChecks(run, duplicateJob, options), null);
  const duplicateCheck = structuredClone(result);
  duplicateCheck.check_runs[1]!.id = duplicateCheck.check_runs[0]!.id;
  assert.equal(acceptFullBaselineChecks(run, duplicateCheck, options), null);
  assert.equal(
    acceptFullBaselineChecks(
      run,
      { ...result, check_runs: checks.slice(1) },
      options,
    ),
    null,
  );
  assert.equal(
    acceptFullBaselineChecks(
      run,
      { ...result, total_count: checks.length + 1 },
      options,
    ),
    null,
  );
  assert.equal(
    acceptFullBaselineChecks(run, { total_count: 0, check_runs: [] }, options),
    null,
  );
  assert.equal(
    acceptFullBaselineChecks(run, result, {
      ...options,
      observedRun: undefined,
    }),
    null,
  );
});

test("CI Checks pagination keeps every page bounded and rejects missing changed or duplicate inventories", async () => {
  for (const count of [1, 100, 101, 205]) {
    const all = Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
    const calls: string[] = [];
    const result = await requestFullBaselineChecks(
      async (url: string) => {
        calls.push(url);
        return {
          total_count: count,
          check_runs: all.slice((calls.length - 1) * 100, calls.length * 100),
        };
      },
      "suite-checks",
      count,
    );
    assert.deepEqual(result, { total_count: count, check_runs: all });
    assert.deepEqual(
      calls,
      Array.from(
        { length: Math.ceil(count / 100) },
        (_, i) => "suite-checks?filter=latest&per_page=100&page=" + (i + 1),
      ),
    );
  }
  const all = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }));
  for (const bad of [
    { total_count: 101, check_runs: [] },
    { total_count: 102, check_runs: all.slice(100) },
    { total_count: 101, check_runs: all.slice(0, 1) },
    { total_count: 101, check_runs: null },
  ]) {
    let calls = 0;
    await assert.rejects(
      requestFullBaselineChecks(
        async () =>
          ++calls === 1
            ? { total_count: 101, check_runs: all.slice(0, 100) }
            : bad,
        "suite-checks",
        101,
      ),
      /Baseline check|Duplicate baseline/,
    );
    assert.equal(calls, 2);
  }
  for (const count of [0, 1.5, 1001]) {
    let calls = 0;
    await assert.rejects(
      requestFullBaselineChecks(
        async () => {
          calls++;
        },
        "suite-checks",
        count,
      ),
      /bounded pagination/,
    );
    assert.equal(calls, 0);
  }
});

test("CI optional baseline observation uses Checks only for unavailable jobs and never qualifies observed failures or concurrent retries", async (t) => {
  const base = "a".repeat(40),
    names = workflowJobNames(workflow);
  const run = {
    id: 17,
    run_attempt: 2,
    check_suite_id: 27,
    head_sha: base,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/project/actions/runs/17",
  };
  const baselineJobs = names.map((name: string, index: number) => ({
    id: index + 1,
    run_id: 17,
    name,
    status: "completed",
    conclusion: "success",
  }));
  const checks = names.map((name: string, index: number) => ({
    id: index + 1,
    check_suite: { id: 27 },
    head_sha: base,
    app: { id: 15368, slug: "github-actions" },
    details_url: run.html_url + "/job/" + (index + 1001),
    name,
    status: "completed",
    conclusion: "success",
  }));
  const directory = await fixture(t, {
    "event.json": JSON.stringify({
      pull_request: { base: { sha: base }, head: { sha: "b".repeat(40) } },
    }),
    output: "",
    summary: "",
  });
  for (const [variant, expectedMode] of [
    ["unavailable", "affected"],
    ["later-unavailable", "affected"],
    ["observed-failure", "full"],
    ["denied", "full"],
    ["malformed", "full"],
    ["foreign-check", "full"],
    ["changed-run", "full"],
  ] as const) {
    const loader = path.join(directory, variant + ".mjs"),
      marker = path.join(directory, variant + ".json");
    await writeFile(
      loader,
      `
import assert from "node:assert/strict";
import fs from "node:fs";
import child from "node:child_process";
import {syncBuiltinESMExports} from "node:module";
const variant=${JSON.stringify(variant)},run=${JSON.stringify(run)},jobs=${JSON.stringify(baselineJobs)},checks=${JSON.stringify(checks)};
const counts={jobs:0,checks:0,runReads:0};
const originalExec=child.execFileSync;
child.execFileSync=(executable,args,...options)=>executable==="git"&&args[0]==="diff"?"docs/README.md"+String.fromCharCode(0):originalExec(executable,args,...options);
syncBuiltinESMExports();
globalThis.fetch=async(address,options)=>{
 assert.equal(options.headers.Authorization,"Bearer synthetic-token");
 const url=new URL(address);assert.equal(url.origin,"https://api.github.com");let body;
 if(url.pathname==="/repos/example/project/actions/workflows/ci.yml/runs") body={workflow_runs:[run]};
 else if(url.pathname==="/repos/example/project/actions/runs/17/attempts/2/jobs") {
  counts.jobs++;
  if(variant==="denied")return new Response("{}",{status:403});
  if(variant==="malformed")return new Response(JSON.stringify({total_count:jobs.length,jobs:null}));
  if((variant==="later-unavailable"||variant==="observed-failure")&&counts.jobs===1){
   body={total_count:jobs.length,jobs:jobs.slice(0,100)};
   if(variant==="observed-failure")body.jobs[0]={...body.jobs[0],conclusion:"failure"};
  }else return new Response("{}",{status:502});
 }else if(url.pathname==="/repos/example/project/check-suites/27/check-runs"){
  counts.checks++;assert.equal(url.searchParams.get("filter"),"latest");assert.equal(url.searchParams.get("per_page"),"100");
  const page=Number(url.searchParams.get("page"));assert.ok(page>=1&&page<=Math.ceil(checks.length/100));
  body={total_count:checks.length,check_runs:checks.slice((page-1)*100,page*100)};
  if(variant==="foreign-check"&&page===1)body.check_runs[0]={...body.check_runs[0],check_suite:{id:28}};
 }else if(url.pathname==="/repos/example/project/actions/runs/17"){
  counts.runReads++;body=variant==="changed-run"?{...run,run_attempt:3}:run;
 }else throw new Error("Unexpected request path "+url.pathname);
 return new Response(JSON.stringify(body),{status:200});
};
process.on("exit",()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(counts)));
`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/project",
      GITHUB_TOKEN: "synthetic-token",
      GITHUB_EVENT_PATH: path.join(directory, "event.json"),
      GITHUB_OUTPUT: path.join(directory, "output"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    };
    delete env.NODE_TEST_CONTEXT;
    env.CHECKTRAIL_CI_OBSERVE_BASELINE = "1";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(loader).href,
        fileURLToPath(new URL("scripts/plan-ci-impact.mjs", root)),
      ],
      { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.mode, "affected", variant + ": " + actual.reason);
    assert.equal(actual.baseline !== null, expectedMode === "affected");
    const counts = JSON.parse(await readFile(marker, "utf8"));
    if (["observed-failure", "denied", "malformed"].includes(variant))
      assert.deepEqual(counts, { jobs: 1, checks: 0, runReads: 0 });
    else {
      assert.equal(counts.jobs, variant === "later-unavailable" ? 2 : 1);
      assert.equal(counts.checks, Math.ceil(names.length / 100));
      assert.equal(counts.runReads, 1);
    }
    assert.deepEqual(selected(actual), []);
  }
  assert.equal(workflow.jobs["ci-plan"].permissions.checks, "read");
});

test("CI shared matrices retain every full command and use selected complete files only for affected pull requests", () => {
  const checks = workflow.jobs.checks;
  assert.deepEqual(checks.needs, ["ci-plan"]);
  assert.match(checks.if, /always\(\).*!cancelled\(\)/);
  assert.match(
    checks.env.CHECKTRAIL_CI_MODE,
    /needs.ci-plan.result == 'success'.*mode \|\| 'full'/,
  );
  assert.deepEqual(checks.strategy.matrix.include, [
    { os: "ubuntu-latest", node: "22" },
    { os: "ubuntu-latest", node: "24" },
    { os: "ubuntu-latest", node: "26" },
    { os: "macos-latest", node: "24" },
  ]);
  const fast = checks.steps.filter(
    (step: { run?: string }) =>
      step.run === "node scripts/verify-ci-affected-tests.mjs",
  );
  assert.equal(fast.length, 1);
  assert.equal(fast[0].if, "env.CHECKTRAIL_CI_MODE == 'affected'");
  const full = checks.steps.find((step: { run?: string }) =>
    step.run?.includes("--full-suite"),
  );
  assert.ok(full);
  assert.equal(full.if, "env.CHECKTRAIL_CI_MODE == 'full'");
  for (const command of [
    "npm ci --ignore-scripts",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "npm run format:check",
    "node scripts/audit-dependencies.mjs",
    "node scripts/audit-context-grammars.mjs",
  ])
    assert.equal(
      checks.steps.find((step: { run?: string }) => step.run === command)?.if,
      undefined,
      command,
    );
  assert.deepEqual(workflow.jobs["host-validation"].needs, ["ci-plan"]);
  assert.match(workflow.jobs["host-validation"].if, /mode == 'full'/);
  const docs = plan(["docs/NATIVE-CI.md"], { baseline: null });
  assert.deepEqual(selected(docs), []);
  assert.deepEqual(docs.sharedTestFiles, [
    "dist/test/artifact-evidence.test.js",
    "dist/test/ci-affected-tests.test.js",
    "dist/test/ci-impact.test.js",
    "dist/test/ci-source-boundaries.test.js",
    "dist/test/gate-inventory.test.js",
  ]);
});

test("CI resource readiness jobs retain every dynamic native harness input and the frozen host matrix", async () => {
  const { resourceReleaseHarnessFiles } = await import(
    new URL("scripts/resource-release-evidence.mjs", root).href
  );
  const owners = ["resource-release", "resource-release-arm64"];
  for (const file of [
    "test/gate-resource-release-readiness.test.ts",
    "test/resource-release-fixture.ts",
    "scripts/prepare-resource-cache-subset.mjs",
    "scripts/native-resource-workload-worker.mjs",
    "scripts/native-child-resource.c",
    "scripts/release-readiness-tools/baseline.json",
  ]) {
    for (const id of owners)
      assert.equal(plan([file]).selected[id], true, file + " omitted " + id);
  }
  assert.deepEqual(
    selected(plan(["test/resource-release-fixture.ts"])),
    owners,
  );
  for (const declared of resourceReleaseHarnessFiles) {
    const file = declared.startsWith("dist/")
      ? declared.slice(5).replace(/\.js$/, ".ts")
      : declared;
    if (
      file.startsWith("scripts/") &&
      !file.startsWith("scripts/required-") &&
      !file.startsWith("scripts/install-") &&
      !file.startsWith("scripts/lifecycle-") &&
      !file.startsWith("scripts/review-") &&
      !file.startsWith("scripts/compiled-")
    )
      for (const id of owners)
        assert.ok(
          inputs[file]?.includes(id),
          file + " lacks " + id + " ownership",
        );
  }
  const resourceMatrix =
    workflow.jobs["resource-release"].strategy.matrix.include;
  const taskMatrix = workflow.jobs["tasks-runtime"].strategy.matrix.include;
  assert.deepEqual(
    [...new Set(taskMatrix.map((entry: { slot: string }) => entry.slot))],
    resourceMatrix.map((entry: { slot: string }) => entry.slot),
  );
  for (const entry of taskMatrix) {
    const pinned = resourceMatrix.find(
      (row: { slot: string }) => row.slot === entry.slot,
    );
    assert.ok(pinned);
    assert.deepEqual(
      { slot: entry.slot, os: entry.os, node: entry.node },
      pinned,
    );
  }
  for (const id of owners) {
    assert.deepEqual(workflow.jobs[id].needs, ["ci-plan", "actionlint"]);
    assert.ok(workflow.jobs["ci-complete"].needs.includes(id));
  }
});

test("CI Windows lanes preserve frozen runtime pins and partition every original runtime cohort behind the completion gate", () => {
  const job = workflow.jobs["tasks-runtime"];
  const entries = job.strategy.matrix.include;
  const windows = entries.filter(
    (entry: { slot: string }) => entry.slot === "windows-node22",
  );
  const pinned = workflow.jobs["resource-release"].strategy.matrix.include.find(
    (entry: { slot: string }) => entry.slot === "windows-node22",
  );
  assert.ok(pinned);
  assert.deepEqual(windows, [
    { ...pinned, lane: "windows-node22", core: true, consumer: false },
    { ...pinned, lane: "windows-consumer-node22", core: false, consumer: true },
  ]);
  for (const entry of entries.filter(
    (row: { slot: string }) => row.slot !== "windows-node22",
  )) {
    assert.equal(entry.lane, entry.slot);
    assert.equal(entry.core, true);
    assert.equal(entry.consumer, true);
  }
  assert.equal(job.name, "tasks-runtime (${{ matrix.lane }})");
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(
    new Set(entries.map((entry: { lane: string }) => entry.lane)).size,
    entries.length,
  );
  const steps = job.steps as Array<{ run?: string; if?: string }>;
  const commands = (condition: string) =>
    steps
      .filter((step) => step.if === condition)
      .flatMap((step) => step.run!.trim().split("\n"));
  assert.deepEqual(commands("matrix.core"), [
    "node scripts/verify-tasks-runtime.mjs ${{ matrix.slot }}",
    "node scripts/verify-required-native-tests.mjs review-runtime-bindings probe-workspace-privacy",
    "node scripts/verify-review-runtime.mjs ${{ matrix.slot }}",
    "node scripts/verify-required-native-tests.mjs lifecycle-runtime-bindings &&",
    "node scripts/verify-lifecycle-platforms.mjs ${{ matrix.slot }}",
  ]);
  assert.deepEqual(commands("matrix.consumer"), [
    "node scripts/verify-required-native-tests.mjs consumer-runtime-bindings consumer-foundation-bindings &&",
    "node scripts/verify-consumer-runtime.mjs ${{ matrix.slot }}",
  ]);
  const names = workflowJobNames(workflow);
  for (const entry of windows)
    assert.equal(
      names.filter((name: string) => name === `tasks-runtime (${entry.lane})`)
        .length,
      1,
    );
  assert.ok(workflow.jobs["ci-complete"].needs.includes("tasks-runtime"));
});

test("CI shared consumer observers retain imports and exact selected context profiles without expanding family labels", async () => {
  const observers = [
    "verify-consumer-witness-profile",
    "consumer-witness-controller",
    "consumer-witness-evidence",
    "consumer-witness-attempts",
    "consumer-witness-jvm",
    "consumer-witness-managed",
    "consumer-witness-data",
    "consumer-witness-swift",
    "consumer-witness-project",
    "consumer-witness-project-controller",
    "consumer-witness-collection",
    "consumer-runtime-selection",
  ];
  const actual = await buildNativeInputs({
    workflow: {
      jobs: {
        ...Object.fromEntries(
          observers.map((name) => [
            name,
            { steps: [{ run: "node scripts/" + name + ".mjs context-go" }] },
          ]),
        ),
        "actual-native": { steps: [{ run: "node scripts/actual-native.mjs" }] },
      },
    },
    requirements: {
      "context-go": [{ file: "dist/test/selected-context.test.js" }],
      go: [{ file: "dist/test/unrelated-go.test.js" }],
      rust: [{ file: "dist/test/unrelated-rust.test.js" }],
      python: [{ file: "dist/test/unrelated-python.test.js" }],
    },
    files: [
      ...observers.map((name) => "scripts/" + name + ".mjs"),
      "scripts/actual-native.mjs",
      "test/selected-context.test.ts",
      "test/observer-helper.ts",
      "test/unrelated-go.test.ts",
      "test/unrelated-rust.test.ts",
      "test/unrelated-python.test.ts",
    ],
    readText: (file: string) =>
      Promise.resolve(
        file === "scripts/actual-native.mjs"
          ? 'const profile = "rust"; runRequiredTests(requirements[profile]);'
          : file.startsWith("scripts/")
            ? 'import "../test/observer-helper.js"; const families = ["go", "rust", "python"];'
            : "",
      ),
  });
  assert.deepEqual(
    actual["test/selected-context.test.ts"],
    [...observers].sort(),
  );
  assert.deepEqual(actual["test/observer-helper.ts"], [...observers].sort());
  assert.deepEqual(actual["test/unrelated-rust.test.ts"], ["actual-native"]);
  for (const family of ["go", "python"])
    assert.equal(
      Object.hasOwn(actual, "test/unrelated-" + family + ".test.ts"),
      false,
    );
  for (const observer of observers)
    assert.deepEqual(actual["scripts/" + observer + ".mjs"], [observer]);
});

test("CI consumer profile aliases in the shared read-only fixture observer preserve imports without selecting unrelated native profile executions", async () => {
  const inputs = await buildNativeInputs({
    workflow: {
      jobs: {
        selected: { steps: [{ run: "node scripts/observer.mjs context-go" }] },
      },
    },
    requirements: {
      "context-go": [{ file: "dist/test/selected.test.js" }],
      "consumer-impact": [{ file: "dist/test/unrelated-consumer.test.js" }],
      "javascript-extensions": [
        { file: "dist/test/unrelated-typescript.test.js" },
      ],
    },
    files: [
      "scripts/observer.mjs",
      "test/consumer-witness-fixture.ts",
      "scripts/consumer-witness-project.mjs",
      "test/selected.test.ts",
      "test/unrelated-consumer.test.ts",
      "test/unrelated-typescript.test.ts",
    ],
    readText: async (file: string) =>
      file === "scripts/observer.mjs"
        ? 'import "../dist/test/consumer-witness-fixture.js";'
        : file === "test/consumer-witness-fixture.ts"
          ? 'const selected=["consumer-impact","javascript-extensions"];import "../scripts/consumer-witness-project.mjs";'
          : "",
  });
  assert.deepEqual(inputs["test/consumer-witness-fixture.ts"], ["selected"]);
  assert.deepEqual(inputs["scripts/consumer-witness-project.mjs"], [
    "selected",
  ]);
  assert.deepEqual(inputs["test/selected.test.ts"], ["selected"]);
  assert.equal(Object.hasOwn(inputs, "test/unrelated-consumer.test.ts"), false);
  assert.equal(
    Object.hasOwn(inputs, "test/unrelated-typescript.test.ts"),
    false,
  );
});
