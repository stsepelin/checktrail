import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";
import { sourceBoundaryInputs } from "./ci-source-boundaries.mjs";
import sourceCatalog from "./ci-source-boundaries.json" with { type: "json" };

const controls = new Set([
  "checks",
  "host-validation",
  "ci-plan",
  "ci-complete",
]);
const retainedArtifactDirectory =
  "docs/measurements/artifact-identities-2026-10-21/";
const generic = new Set([
  "scripts/verify-required-native-tests.mjs",
  "scripts/required-test-evidence.mjs",
  "scripts/verify-import-context-package.mjs",
  "scripts/verify-mutation-guards.mjs",
  // The consumer entry point uses the workflow's exact context-* argument.
  // Shared observer family labels are data, not separate native invocations.
  "scripts/verify-consumer-witness-profile.mjs",
  "scripts/consumer-witness-controller.mjs",
  "scripts/consumer-witness-evidence.mjs",
  "scripts/consumer-witness-attempts.mjs",
  "scripts/consumer-witness-jvm.mjs",
  "scripts/consumer-witness-managed.mjs",
  "scripts/consumer-witness-data.mjs",
  "scripts/consumer-witness-swift.mjs",
  "scripts/consumer-witness-project.mjs",
  "scripts/selected-clang-consumer-witness.mjs",
  "test/selected-clang-consumer-fixture.ts",
  "scripts/consumer-witness-project-controller.mjs",
  "scripts/consumer-witness-collection.mjs",
  "scripts/consumer-runtime-selection.mjs",
  "test/consumer-witness-fixture.ts",
]);
const compiledSource = (file) =>
  file.startsWith("dist/") ? file.slice(5).replace(/\.js$/, ".ts") : file;
const validPath = (file) =>
  typeof file === "string" &&
  file.length <= 1024 &&
  !path.posix.isAbsolute(file) &&
  !file.split("/").some((p) => ["", ".", ".."].includes(p));
export const nativeJobIds = (workflow) =>
  Object.keys(workflow.jobs)
    .filter((id) => !controls.has(id))
    .sort();

// This enumerates declared file references. The checked-in map is a reviewable
// contract, not a claim that lexical analysis proves every runtime dependency.
// General source, schemas, dependency/config changes and unclassified paths
// stay global. Only reviewed standalone runner boundaries can narrow source.
export async function buildNativeInputs({
  workflow,
  requirements,
  files,
  readText,
}) {
  const available = new Set(files),
    owners = new Map();
  const profiles = new Set(Object.keys(requirements));
  const resolve = (file) => {
    file = compiledSource(path.posix.normalize(file));
    return available.has(file) ? file : null;
  };
  for (const id of nativeJobIds(workflow)) {
    const pending = [],
      visited = new Set();
    const admit = (file) => {
      const resolved = resolve(file);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    };
    const references = (text, parent, expandProfiles) => {
      for (const match of text.matchAll(
        /(?:scripts|dist\/test|test|assets|examples|schemas|packs|docs)\/[a-zA-Z0-9_./-]+/g,
      )) {
        // Other documentation may define shared policy and stays unclassified.
        if (
          match[0].startsWith("docs/") &&
          !match[0].startsWith(retainedArtifactDirectory)
        )
          continue;
        admit(match[0]);
      }
      if (expandProfiles) {
        // Image repository names are setup data, not native profile arguments.
        // Keep explicit profile invocations after an address visible.
        const profileText = text.replace(
          /\b(?:docker\.io|public\.ecr\.aws|mcr\.microsoft\.com)\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}(?![a-f0-9])/g,
          " ",
        );
        for (const token of profileText.match(/[a-z][a-z0-9-]*/g) ?? []) {
          if (profiles.has(token))
            for (const item of requirements[token]) admit(item.file);
        }
      }
      if (parent) {
        const source = ts.createSourceFile(
          parent,
          text,
          ts.ScriptTarget.Latest,
          true,
        );
        const walk = (node) => {
          if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text.startsWith(".")
          ) {
            admit(
              path.posix
                .join(path.posix.dirname(parent), node.moduleSpecifier.text)
                .replace(/\.js$/, ".ts"),
            );
            admit(
              path.posix.join(
                path.posix.dirname(parent),
                node.moduleSpecifier.text,
              ),
            );
          }
          ts.forEachChild(node, walk);
        };
        walk(source);
      }
    };
    for (const step of workflow.jobs[id].steps)
      if (step.run) references(step.run, null, true);
    // Resolve the finite workflow matrix entries instead of treating the
    // interpolated script/profile as an unknown or one representative case.
    const matrix = workflow.jobs[id].strategy?.matrix;
    if (matrix) {
      for (const entry of matrix.include ?? []) {
        if (typeof entry.script === "string") admit("scripts/" + entry.script);
        for (const value of Object.values(entry))
          if (profiles.has(value))
            for (const item of requirements[value]) admit(item.file);
      }
      for (const values of Object.values(matrix))
        if (Array.isArray(values)) {
          for (const value of values)
            if (profiles.has(value))
              for (const item of requirements[value]) admit(item.file);
        }
    }
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      // Do not infer source isolation from names or shared engine traversal.
      // The explicit subprocess source contract is validated after this graph.
      if (
        file.startsWith("src/") ||
        file.startsWith("scripts/ci-") ||
        [
          "scripts/plan-ci-impact.mjs",
          "scripts/check-ci-completion.mjs",
        ].includes(file)
      )
        continue;
      if (!owners.has(file)) owners.set(file, new Set());
      owners.get(file).add(id);
      if (/\.(?:mjs|ts|js)$/.test(file)) {
        const text = await readText(file);
        references(
          text,
          file,
          file.startsWith("scripts/") && !generic.has(file),
        );
      }
    }
  }
  const declaredSources = await sourceBoundaryInputs({
    files,
    requirements,
    jobs: nativeJobIds(workflow),
    inputs: Object.fromEntries(
      [...owners].map(([file, jobs]) => [file, [...jobs]]),
    ),
    readText,
  });
  for (const [file, jobs] of Object.entries(declaredSources))
    owners.set(file, new Set(jobs));
  return Object.fromEntries(
    [...owners]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, jobs]) => [file, [...jobs].sort()]),
  );
}
export function validateInputContract(inputs, jobs) {
  assert.ok(inputs && typeof inputs === "object" && !Array.isArray(inputs));
  assert.ok(
    Object.keys(inputs).length > 0 && Object.keys(inputs).length < 20000,
  );
  assert.ok(
    jobs.every((id) =>
      Object.values(inputs).some((owners) => owners.includes(id)),
    ),
    "Native job has no declared input",
  );
  for (const [file, owners] of Object.entries(inputs)) {
    assert.ok(validPath(file), "Invalid CI input path");
    assert.ok(
      Array.isArray(owners) &&
        owners.length > 0 &&
        new Set(owners).size === owners.length,
    );
    assert.ok(
      owners.every((id) => jobs.includes(id)),
      "Unknown CI input owner",
    );
  }
}
export function planNativeJobs({
  jobs,
  inputs,
  changed,
  eventName,
  baseline,
  contractCurrent = true,
  sourceBoundaries = sourceCatalog.boundaries,
}) {
  validateInputContract(inputs, jobs);
  const full = (reason) => ({
    mode: "full",
    reason,
    selected: Object.fromEntries(jobs.map((id) => [id, true])),
    notSelected: [],
    baseline: null,
  });
  if (eventName !== "pull_request")
    return full("Non-PR verification always runs every native job");
  if (!contractCurrent)
    return full("Declared native input contract changed or is stale");
  if (
    !Array.isArray(changed) ||
    !changed.length ||
    changed.length > 10000 ||
    !changed.every(validPath)
  )
    return full("Missing, empty or invalid changed-file inventory");
  const selected = new Set();
  for (const file of changed) {
    // Retained observations are data consumed by the always-required artifact
    // audit and its complete regression file. New/unindexed data still fails
    // that audit. The trailing slash excludes adjacent directory names, and
    // recorded native consumers are preserved rather than replaced.
    if (file.startsWith(retainedArtifactDirectory)) {
      for (const id of inputs[file] ?? []) selected.add(id);
      continue;
    }
    // Markdown retains shared audits and the always-required control files.
    // Other documentation formats can carry executable inventories and stay global.
    if (
      /^(?:docs\/.*\.md|README\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE)$/.test(
        file,
      )
    )
      continue;
    if (
      (file.startsWith("src/") && !Object.hasOwn(inputs, file)) ||
      file.startsWith("schemas/") ||
      file.startsWith("packs/") ||
      file.startsWith(".github/") ||
      file.startsWith("scripts/ci-") ||
      [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "eslint.config.js",
        "scripts/required-native-tests.json",
        "scripts/ci-impact.mjs",
        "scripts/plan-ci-impact.mjs",
        "scripts/check-ci-completion.mjs",
        "scripts/jvm-wrapper-phase-evidence.mjs",
      ].includes(file)
    )
      return full(
        "Shared runtime, dependency, inventory or CI input changed: " + file,
      );
    if (!Object.hasOwn(inputs, file))
      return full("Unclassified input changed: " + file);
    for (const id of inputs[file]) selected.add(id);
  }
  return {
    mode: "affected",
    reason:
      "Exact declared native inputs with complete selected shared test files",
    selected: Object.fromEntries(jobs.map((id) => [id, selected.has(id)])),
    notSelected: jobs.filter((id) => !selected.has(id)),
    baseline: baseline?.complete ? baseline : null,
    sharedTestFiles: [
      ...new Set([
        "dist/test/artifact-evidence.test.js",
        "dist/test/ci-impact.test.js",
        "dist/test/gate-inventory.test.js",
        "dist/test/ci-affected-tests.test.js",
        "dist/test/ci-source-boundaries.test.js",
        ...sourceBoundaries
          .filter((row) => changed.includes(row.file))
          .flatMap((row) => row.testFiles)
          .map((file) => "dist/" + file.replace(/\.ts$/, ".js")),
        ...Object.entries(inputs)
          .filter(
            ([file, owners]) =>
              file.startsWith("test/") &&
              file.endsWith(".test.ts") &&
              owners.some((id) => selected.has(id)),
          )
          .map(([file]) => "dist/" + file.replace(/\.ts$/, ".js")),
      ]),
    ].sort(),
  };
}
export function requireCiCompletion(plan, needs) {
  assert.ok(plan && ["full", "affected"].includes(plan.mode));
  assert.ok(
    Object.values(plan.selected).every(
      (selected) => typeof selected === "boolean",
    ),
  );
  assert.deepEqual(
    plan.notSelected.toSorted(),
    Object.keys(plan.selected)
      .filter((id) => !plan.selected[id])
      .sort(),
  );
  assert.ok(
    plan.mode !== "full" || Object.values(plan.selected).every(Boolean),
    "Full verification cannot omit a native job",
  );
  const expected = [
    "ci-plan",
    "checks",
    "host-validation",
    ...Object.keys(plan.selected),
  ];
  assert.deepEqual(
    Object.keys(needs).sort(),
    expected.sort(),
    "CI completion job inventory differs from the plan",
  );
  for (const id of expected) {
    const required =
      ["ci-plan", "checks"].includes(id) ||
      (id === "host-validation" ? plan.mode === "full" : plan.selected[id]);
    assert.equal(
      needs[id].result,
      required ? "success" : "skipped",
      "CI outcome disagrees with selection: " + id,
    );
  }
  if (plan.mode === "affected") {
    assert.ok(
      Array.isArray(plan.sharedTestFiles) && plan.sharedTestFiles.length >= 2,
    );
    assert.ok(
      plan.sharedTestFiles.every((file) =>
        /^dist\/test\/[a-z0-9-]+\.test\.js$/.test(file),
      ),
    );
    assert.equal(
      new Set(plan.sharedTestFiles).size,
      plan.sharedTestFiles.length,
    );
  }
  return {
    complete: true,
    mode: plan.mode,
    selectedNativeJobs: Object.keys(plan.selected).filter(
      (id) => plan.selected[id],
    ),
    notSelectedNativeJobs: plan.notSelected,
    baseline: plan.baseline,
    fullRevisionVerification: plan.mode === "full",
    omittedJobsQualified: false,
  };
}

export function workflowJobNames(workflow) {
  return Object.entries(workflow.jobs)
    .flatMap(([id, job]) => {
      const matrix = job.strategy?.matrix;
      if (!matrix) return [job.name ?? id];
      const variants =
        matrix.include ??
        Object.entries(matrix).reduce(
          (rows, [name, values]) =>
            rows.flatMap((row) =>
              values.map((value) => ({ ...row, [name]: value })),
            ),
          [{}],
        );
      return variants.map((entry) =>
        job.name
          ? job.name.replace(
              /\$\{\{\s*matrix\.([a-z]+)\s*\}\}/g,
              (_, name) => entry[name],
            )
          : id + " (" + Object.values(entry).join(", ") + ")",
      );
    })
    .sort();
}
// Bind every page to one immutable run attempt and the declared job inventory.
// Any short, changing or oversized inventory falls back to full verification.
export async function requestFullBaselineJobs(
  request,
  endpoint,
  expectedCount,
) {
  assert.ok(
    Number.isSafeInteger(expectedCount) &&
      expectedCount > 0 &&
      expectedCount <= 1000,
    "Baseline job inventory exceeds the bounded pagination contract",
  );
  const jobs = [];
  for (let page = 1; page <= Math.ceil(expectedCount / 100); page++) {
    const result = await request(endpoint + "?per_page=100&page=" + page);
    assert.equal(
      result.total_count,
      expectedCount,
      "Baseline job inventory changed",
    );
    assert.ok(Array.isArray(result.jobs), "Baseline job page is malformed");
    assert.equal(
      result.jobs.length,
      Math.min(100, expectedCount - jobs.length),
      "Baseline job page is incomplete",
    );
    jobs.push(...result.jobs);
  }
  assert.equal(
    new Set(jobs.map((job) => job.id)).size,
    expectedCount,
    "Duplicate baseline job",
  );
  return { total_count: expectedCount, jobs };
}

export function acceptFullBaseline(run, result, { base, expectedNames }) {
  if (
    !run ||
    run.head_sha !== base ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0
  )
    return null;
  if (
    !result ||
    !Array.isArray(result.jobs) ||
    !result.jobs.length ||
    result.total_count !== result.jobs.length ||
    new Set(result.jobs.map((job) => job.id)).size !== result.jobs.length ||
    result.jobs.some(
      (job) =>
        job.run_id !== run.id ||
        job.status !== "completed" ||
        job.conclusion !== "success",
    )
  )
    return null;
  if (
    JSON.stringify(result.jobs.map((job) => job.name).sort()) !==
    JSON.stringify(expectedNames)
  )
    return null;
  return {
    complete: true,
    commit: base,
    run: run.html_url,
    jobs: result.jobs.length,
  };
}

// Checks are an alternate observation of one successful Actions run, never a
// substitute for missing, failed or skipped jobs returned by the jobs API.
export async function requestFullBaselineChecks(
  request,
  endpoint,
  expectedCount,
) {
  assert.ok(
    Number.isSafeInteger(expectedCount) &&
      expectedCount > 0 &&
      expectedCount <= 1000,
    "Baseline check inventory exceeds the bounded pagination contract",
  );
  const checks = [];
  for (let page = 1; page <= Math.ceil(expectedCount / 100); page++) {
    const result = await request(
      endpoint + "?filter=latest&per_page=100&page=" + page,
    );
    assert.equal(
      result.total_count,
      expectedCount,
      "Baseline check inventory changed",
    );
    assert.ok(
      Array.isArray(result.check_runs),
      "Baseline check page is malformed",
    );
    assert.equal(
      result.check_runs.length,
      Math.min(100, expectedCount - checks.length),
      "Baseline check page is incomplete",
    );
    checks.push(...result.check_runs);
  }
  assert.equal(
    new Set(checks.map((check) => check.id)).size,
    expectedCount,
    "Duplicate baseline check",
  );
  return { total_count: expectedCount, check_runs: checks };
}

export function acceptFullBaselineChecks(
  run,
  result,
  { base, expectedNames, repository, observedRun },
) {
  const fields = [
    "id",
    "run_attempt",
    "check_suite_id",
    "head_sha",
    "head_branch",
    "event",
    "status",
    "conclusion",
    "html_url",
  ];
  if (
    !run ||
    !observedRun ||
    fields.some((field) => run[field] !== observedRun[field]) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    !Number.isSafeInteger(run.check_suite_id) ||
    run.check_suite_id <= 0 ||
    typeof repository !== "string" ||
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    run.html_url !==
      "https://github.com/" + repository + "/actions/runs/" + run.id ||
    !result ||
    !Array.isArray(result.check_runs)
  )
    return null;
  const jobIds = new Set();
  for (const check of result.check_runs) {
    if (
      !check ||
      typeof check !== "object" ||
      !Number.isSafeInteger(check.id) ||
      check.id <= 0 ||
      check.check_suite?.id !== run.check_suite_id ||
      check.head_sha !== base ||
      check.app?.id !== 15368 ||
      check.app?.slug !== "github-actions" ||
      typeof check.details_url !== "string" ||
      !check.details_url.startsWith(run.html_url + "/job/")
    )
      return null;
    const suffix = check.details_url.slice((run.html_url + "/job/").length);
    if (
      !/^[1-9][0-9]*$/.test(suffix) ||
      !Number.isSafeInteger(Number(suffix)) ||
      jobIds.has(suffix)
    )
      return null;
    jobIds.add(suffix);
  }
  return acceptFullBaseline(
    run,
    {
      total_count: result.total_count,
      jobs: result.check_runs.map((check) => ({
        id: check.id,
        run_id: run.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
      })),
    },
    { base, expectedNames },
  );
}
