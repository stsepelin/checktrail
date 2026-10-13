import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";
const {
  buildNativeInputs,
  acceptFullBaseline,
  requestFullBaselineJobs,
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
    "test/deleted-old-fixture.ts",
  ]) {
    const result = plan([file]);
    assert.equal(result.mode, "full", file);
    assert.deepEqual(selected(result), jobs);
  }
  assert.equal(plan(["README.md", "docs/NATIVE-CI.md"]).mode, "affected");
  assert.deepEqual(selected(plan(["README.md", "docs/NATIVE-CI.md"])), []);
});
test("CI unknown missing stale and non-PR baselines always select the complete native inventory", () => {
  for (const options of [
    { baseline: null },
    { baseline: { complete: false } },
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
          id === "scala-extensions-arm64" || !jobs.includes(id)
            ? "success"
            : "skipped",
      },
    ]),
  );
  const receipt = requireCiCompletion(result, needs);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.selectedNativeJobs, ["scala-extensions-arm64"]);
  assert.ok(receipt.notSelectedNativeJobs.includes("jvm-wrappers-arm64"));
  for (const id of [
    "ci-plan",
    "checks",
    "host-validation",
    "scala-extensions-arm64",
  ])
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
  assert.throws(
    () => requireCiCompletion(falseBaseline, needs),
    /accepted exact base/,
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
  assert.equal(
    initial.reduce(
      (n, [, job]) => n + variants(job as Parameters<typeof variants>[0]),
      0,
    ),
    20,
  );
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

test("CI split matrix retains each runner's package cache before Linux installed-container acceptance", () => {
  const steps = workflow.jobs.checks.steps;
  const cache = steps.findIndex(
    (step: { run?: string }) =>
      step.run === "node scripts/prepare-package-cache.mjs",
  );
  assert.ok(cache >= 0);
  assert.equal(
    steps[cache].if,
    "matrix.os == 'ubuntu-latest' && matrix.node == '22'",
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
