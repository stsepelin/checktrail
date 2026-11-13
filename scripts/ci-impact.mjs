import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { sourceBoundaryInputs } from "./ci-source-boundaries.mjs";
import sourceCatalog from "./ci-source-boundaries.json" with { type: "json" };
import {
  consumerNativeEntrypoint,
  consumerNativeProfiles,
} from "./consumer-native-entrypoints.mjs";

const controls = new Set([
  "checks",
  "full-suite-shards",
  "host-validation",
  "ci-plan",
  "ci-complete",
]);
const retainedArtifactDirectory =
  "docs/measurements/artifact-identities-2026-10-21/";
// Reviewed shared helper/preparation controls run as complete test files.
// Derive their native consumers from the exact declared inputs; do not
// classify neighboring test names or create entries for absent files.
const preparationRegressionSources = Object.freeze({
  "test/scala-native-ci-phases.test.ts": ["scripts/scala-native-ci-phases.mjs"],
  "test/native-process-observer.test.ts": Object.freeze([
    "test/native-process-observer.ts",
  ]),
  "test/dotnet-generator-shards.test.ts": Object.freeze([
    "scripts/verify-dotnet-generator-extensions-container.mjs",
  ]),
  "test/dotnet-generator-ci.test.ts": Object.freeze([
    "scripts/verify-dotnet-generator-extensions-container.mjs",
  ]),
  "test/github-artifact-delivery.test.ts": Object.freeze([
    "scripts/prepare-infra-tools-runtime.mjs",
    "scripts/prepare-scala-tools.mjs",
    "scripts/prepare-scala2-tools.mjs",
  ]),
  "test/swift-preparation.test.ts": Object.freeze([
    "scripts/prepare-swift-tools-runtime.mjs",
    "scripts/prepare-swift-extensions-runtime.mjs",
  ]),
});
// Reviewed development-only producer inputs have no packaged runtime member.
// Shared identity and retention controls also feed Binutils, Go and Node, so
// every exact input selects those callers' complete regression files as well.
// Unknown siblings continue to require full verification.
const cProducerRegressionFiles = Object.freeze([
  "test/binutils-acquisition.test.ts",
  "test/binutils-build-observation.test.ts",
  "test/binutils-controller-inputs.test.ts",
  "test/binutils-download.test.ts",
  "test/binutils-image-identity.test.ts",
  "test/binutils-input-preparation.test.ts",
  "test/binutils-retention-observer.test.ts",
  "test/c-producer-evidence.test.ts",
  "test/c-producer-gcc-evidence.test.ts",
  "test/c-producer-local12h.test.ts",
  "test/c-producer-qualification.test.ts",
  "test/c-producer-quiescence.test.ts",
  "test/c-producer-replay-batch.test.ts",
  "test/c-producer-report-capture.test.ts",
  "test/c-producer-report-codec.test.ts",
  "test/c-producer-report-transport.test.ts",
  "test/c-producer-source-epoch.test.ts",
  "test/c-producer-u13.test.ts",
  "test/gcc-job-envelope.test.ts",
  "test/glibc-seccomp.test.ts",
  "test/go-bootstrap-producer.test.ts",
  "test/go-bootstrap-transport.test.ts",
  "test/node-original-acquisition.test.ts",
  "test/node-original-materializer.test.ts",
  "test/node-original-producer.test.ts",
  "test/node-original-retention.test.ts",
  "test/node-original-transport-posix.test.ts",
  "test/producer-container-cleanup.test.ts",
  "test/producer-qualification.test.ts",
  "test/web-runtime-producer.test.ts",
]);
export const cProducerSharedBoundary = Object.freeze({
  // Names only: editing a reviewed member does not invalidate its fast path.
  // A new helper, fixture, test or workflow needs an explicit inventory review.
  inventorySha256:
    "56b2c02f5db2656ffb7a27d5677fcff6cda52afd4a73698e9c3e84290c36b960",
  files: Object.freeze([
    "scripts/acquire-binutils-inputs.mjs",
    "scripts/acquire-c-producer-inputs.mjs",
    "scripts/observe-c-producer-carrier.mjs",
    "scripts/qualify-binutils-producer.mjs",
    "scripts/qualify-c-producer.mjs",
    "scripts/qualify-go-bootstrap-producer.mjs",
    "scripts/qualify-node-original-producer.mjs",
    "scripts/verify-binutils-build-observation.mjs",
    "scripts/verify-binutils-retention-observer.mjs",
    "scripts/verify-c-producer-observation.mjs",
    "scripts/producer-qualification/binutils-acquisition-plan.mjs",
    "scripts/producer-qualification/binutils-apt-index-preparation.v1.json",
    "scripts/producer-qualification/binutils-build.sh",
    "scripts/producer-qualification/binutils-expectations.v1.json",
    "scripts/producer-qualification/binutils-export-evidence.py",
    "scripts/producer-qualification/binutils-image-identity.mjs",
    "scripts/producer-qualification/binutils-image-identity.v1.json",
    "scripts/producer-qualification/binutils-input-reacquisition.v1.json",
    "scripts/producer-qualification/binutils-prepare-inputs.py",
    "scripts/producer-qualification/binutils-retention-observer.mjs",
    "scripts/producer-qualification/binutils-retention-observer.py",
    "scripts/producer-qualification/binutils-test-reports.py",
    "scripts/producer-qualification/binutils.v1.json",
    "scripts/producer-qualification/c-carrier-observation.mjs",
    "scripts/producer-qualification/c-producer-build.sh",
    "scripts/producer-qualification/c-producer-export-evidence.py",
    "scripts/producer-qualification/c-producer-profile.mjs",
    "scripts/producer-qualification/c-producer-profiles.v1.json",
    "scripts/producer-qualification/c-producer-quiescent-sample.mjs",
    "scripts/producer-qualification/c-producer-replay-evidence.py",
    "scripts/producer-qualification/c-producer-report-codec.mjs",
    "scripts/producer-qualification/c-producer-report-codec.py",
    "scripts/producer-qualification/c-producer-test-reports.py",
    "scripts/producer-qualification/c-report-encoding.v1.json",
    "scripts/producer-qualification/gcc-github-job-clock.mjs",
    "scripts/producer-qualification/gcc-job-envelope.mjs",
    "scripts/producer-qualification/gcc-local-12h-policy.v1.json",
    "scripts/producer-qualification/gcc-local-wall-policy.v1.json",
    "scripts/producer-qualification/glibc-seccomp-probe.py",
    "scripts/producer-qualification/glibc-seccomp.mjs",
    "scripts/producer-qualification/glibc-seccomp.v1.json",
    "test/fixtures/c-controller-history/LICENSE-schema1.txt",
    "test/fixtures/c-controller-history/LICENSE-schema2.txt",
    "test/fixtures/c-controller-history/provenance.json",
    "test/fixtures/c-controller-history/report-collector-provenance.json",
    "test/fixtures/c-controller-history/schema1-controller.mjs.txt",
    "test/fixtures/c-controller-history/schema2-controller.mjs.txt",
    "test/fixtures/c-controller-history/schema2-report-collector.py.txt",
    "test/fixtures/c-producer-epoch-routing.mjs",
    "test/fixtures/c-producer-interruption.py",
    "test/fixtures/c-producer-local-clock.mjs",
    "test/fixtures/c-retention-controls.py",
    "test/fixtures/c-retention-quiescent-rename.py",
    ...cProducerRegressionFiles,
  ]),
  workflowFiles: Object.freeze([
    ".github/workflows/upstream-binutils.yml",
    ".github/workflows/upstream-gcc.yml",
    ".github/workflows/upstream-glibc.yml",
    ".github/workflows/upstream-glibc-u13.yml",
  ]),
  testFiles: cProducerRegressionFiles,
});
const generic = new Set([
  "scripts/request-pinned-artifact.mjs",
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
  "scripts/consumer-native-acceptance-scope.mjs",
  "scripts/consumer-native-acceptance-frame.mjs",
  "scripts/consumer-native-entrypoints.mjs",
  "scripts/consumer-native-acceptance-capsule.mjs",
  "scripts/selected-clang-consumer-witness.mjs",
  "test/selected-clang-consumer-fixture.ts",
  "scripts/consumer-witness-project-controller.mjs",
  "scripts/consumer-witness-collection.mjs",
  "scripts/consumer-runtime-selection.mjs",
  "test/consumer-witness-fixture.ts",
]);
// Reviewed delivery/selector/observer helpers acquire bytes, return targets or hash
// harness bytes without executing native controllers/tests. Static imports remain
// inputs; detected execution primitives restore conservative full profile expansion.
const consumerDataSelectors = new Set([
  "scripts/request-pinned-artifact.mjs",
  "scripts/consumer-native-entrypoints.mjs",
  "scripts/consumer-native-acceptance-scope.mjs",
  "scripts/consumer-native-acceptance-capsule.mjs",
  "scripts/selected-clang-consumer-witness.mjs",
]);
const consumerControllerPaths = new Set(
  consumerNativeProfiles
    .flatMap((profile) =>
      consumerNativeEntrypoint(profile, "native-linux-arm64-node22").slice(
        0,
        1,
      ),
    )
    .concat("scripts/verify-consumer-runtime.mjs"),
);
const compiledSource = (file) =>
  file.startsWith("dist/") ? file.slice(5).replace(/\.js$/, ".ts") : file;
const validPath = (file) =>
  typeof file === "string" &&
  file.length <= 1024 &&
  !path.posix.isAbsolute(file) &&
  !file.split("/").some((p) => ["", ".", ".."].includes(p));
// The caller supplies the complete tracked inventory it used for the native
// input contract. Pure metadata only; the planner never reads the filesystem.
export function producerInventoryFingerprint(files) {
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > 100000 ||
    !Array.from(files).every(validPath) ||
    new Set(files).size !== files.length
  )
    return null;
  return createHash("sha256")
    .update(
      JSON.stringify(
        files
          .filter((file) =>
            ["test/", "scripts/", ".github/workflows/"].some((prefix) =>
              file.startsWith(prefix),
            ),
          )
          .sort(),
      ),
    )
    .digest("hex");
}
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
      const selector = consumerDataSelectors.has(parent),
        dataOnly =
          selector &&
          !/\b(?:runRequiredTests|runProcess|spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|eval|import)\s*\(|["']node:child_process["']/.test(
            text,
          );
      if (selector && !dataOnly)
        for (const rows of Object.values(requirements))
          for (const item of rows) admit(item.file);
      for (const match of text.matchAll(
        /(?:scripts|dist\/test|test|assets|examples|schemas|packs|docs)\/[a-zA-Z0-9_./-]+/g,
      )) {
        // Other documentation may define shared policy and stays unclassified.
        if (
          match[0].startsWith("docs/") &&
          !match[0].startsWith(retainedArtifactDirectory)
        )
          continue;
        if (
          dataOnly &&
          (consumerControllerPaths.has(match[0]) ||
            compiledSource(match[0]).startsWith("test/"))
        )
          continue;
        admit(match[0]);
      }
      if (expandProfiles || (selector && !dataOnly)) {
        // Image repository names are setup data, not native profile arguments.
        // Keep explicit profile invocations after an address visible.
        const profileText = text.replace(
          /\b(?:docker\.io|public\.ecr\.aws|mcr\.microsoft\.com)\/[a-z0-9_./-]+@sha256:[a-f0-9]{64}(?![a-f0-9])/g,
          " ",
        );
        // Match whole identifiers, including Unicode continuations. File-name
        // tokens remain conservative metadata; helper-name fragments do not.
        for (const [, token] of profileText.matchAll(
          /(?<![\p{ID_Continue}\p{Join_Control}$#-])([a-z][a-z0-9-]*)(?![\p{ID_Continue}\p{Join_Control}$#-])/gu,
        )) {
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
    const matrixEntries = workflow.jobs[id].strategy?.matrix?.include ?? [];
    for (const step of workflow.jobs[id].steps)
      if (step.run) {
        references(step.run, null, true);
        if (
          step.run.includes("scripts/verify-consumer-native-acceptance.mjs")
        ) {
          const variants = matrixEntries.length ? matrixEntries : [{}];
          for (const entry of variants) {
            const expanded = step.run.replace(
              /\$\{\{\s*matrix\.([a-zA-Z0-9_-]+)\s*\}\}/g,
              (whole, key) =>
                typeof entry[key] === "string" ? entry[key] : whole,
            );
            const calls = [
              ...expanded.matchAll(
                /scripts\/verify-consumer-native-acceptance\.mjs\s+(\S+)\s+(\S+)/g,
              ),
            ];
            if (!calls.length)
              for (const rows of Object.values(requirements))
                for (const item of rows) admit(item.file);
            for (const call of calls)
              try {
                for (const target of consumerNativeEntrypoint(
                  call[1],
                  call[2],
                ).slice(0, 1))
                  admit(target);
              } catch {
                for (const rows of Object.values(requirements))
                  for (const item of rows) admit(item.file);
              }
          }
        }
      }
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
  for (const [file, sources] of Object.entries(preparationRegressionSources)) {
    if (!available.has(file)) continue;
    const selected = new Set(owners.get(file));
    for (const source of sources) {
      assert.ok(
        available.has(source) && owners.get(source)?.size > 0,
        "Shared regression requires its declared native input",
      );
      for (const job of owners.get(source)) selected.add(job);
    }
    owners.set(file, selected);
  }
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
function qualifiedMainPush(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = [
    "schemaVersion",
    "ref",
    "before",
    "after",
    "githubSha",
    "checkoutSha",
    "ancestorVerified",
    "comparison",
    "forced",
    "deleted",
    "repository",
    "githubRepository",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    return false;
  const sha = (candidate) =>
    typeof candidate === "string" &&
    /^[a-f0-9]{40}$/u.test(candidate) &&
    candidate !== "0".repeat(40);
  const repository = (candidate) =>
    typeof candidate === "string" &&
    candidate.length <= 201 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate) &&
    candidate
      .split("/")
      .every((part) => part !== "." && part !== ".." && part.length <= 100);
  return (
    repository(value.repository) &&
    value.githubRepository === value.repository &&
    value.schemaVersion === 1 &&
    value.ref === "refs/heads/main" &&
    sha(value.before) &&
    sha(value.after) &&
    value.before !== value.after &&
    value.githubSha === value.after &&
    value.checkoutSha === value.after &&
    value.ancestorVerified === true &&
    value.comparison === "before..after" &&
    value.forced === false &&
    value.deleted === false
  );
}

function validProducerBoundary(boundary) {
  if (
    !boundary ||
    typeof boundary !== "object" ||
    Array.isArray(boundary) ||
    typeof boundary.inventorySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(boundary.inventorySha256)
  )
    return false;
  for (const key of ["files", "workflowFiles", "testFiles"]) {
    const files = boundary[key];
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > 10000 ||
      !Array.from(files).every(validPath) ||
      new Set(files).size !== files.length
    )
      return false;
  }
  const files = new Set(boundary.files);
  return (
    boundary.workflowFiles.every((file) => !files.has(file)) &&
    boundary.testFiles.every(
      (file) =>
        files.has(file) &&
        file.startsWith("test/") &&
        file.endsWith(".test.ts"),
    )
  );
}
export function planNativeJobs({
  jobs,
  inputs,
  changed,
  eventName,
  baseline,
  contractCurrent = false,
  sourceBoundaries = sourceCatalog.boundaries,
  producerInventory = null,
  producerBoundary = cProducerSharedBoundary,
  qualifiedPush = null,
}) {
  validateInputContract(inputs, jobs);
  const full = (reason) => ({
    mode: "full",
    hostValidation: "required",
    reason,
    selected: Object.fromEntries(jobs.map((id) => [id, true])),
    notSelected: [],
    baseline: null,
  });
  if (!validProducerBoundary(producerBoundary))
    return full("Invalid reviewed producer boundary policy");
  const cProducerSharedInputs = new Set([
    ...producerBoundary.files,
    ...producerBoundary.workflowFiles,
  ]);
  const cProducerWorkflowInputs = new Set(producerBoundary.workflowFiles);
  if (["pull_request", "push"].includes(eventName) && contractCurrent !== true)
    return full("Declared native input contract changed or is stale");
  if (
    eventName !== "pull_request" &&
    !(eventName === "push" && qualifiedMainPush(qualifiedPush))
  )
    return full(
      eventName === "push"
        ? "Push verification requires a qualified non-forced main transition"
        : "Dispatch, scheduled or unsupported events require complete native verification",
    );
  if (
    !Array.isArray(changed) ||
    !changed.length ||
    changed.length > 10000 ||
    !Array.from(changed).every(validPath)
  )
    return full("Missing, empty or invalid changed-file inventory");
  if (
    changed.some((file) => cProducerSharedInputs.has(file)) &&
    producerInventoryFingerprint(producerInventory) !==
      producerBoundary.inventorySha256
  )
    return full(
      "Producer-only inventory is missing or changed; review new test/helper/workflow names and refresh the producer boundary",
    );
  const selected = new Set();
  for (const file of changed) {
    // The caller rebuilt this exact generated contract before setting
    // contractCurrent. Route its source changes normally; the generated map
    // itself neither adds execution nor qualifies any omitted native job.
    if (file === "scripts/ci-native-inputs.json") continue;
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
    // Only these reviewed original-producer workflows use the producer-only
    // boundary. Keep workflow syntax verification and every declared consumer.
    // Shared CI and unreviewed adjacent workflows retain the full fallback below.
    if (cProducerWorkflowInputs.has(file)) {
      if (!jobs.includes("actionlint"))
        return full("Producer workflow requires the declared actionlint job");
      selected.add("actionlint");
      for (const id of inputs[file] ?? []) selected.add(id);
      continue;
    }
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
    if (!Object.hasOwn(inputs, file) && !cProducerSharedInputs.has(file))
      return full("Unclassified input changed: " + file);
    // The shared boundary adds regression coverage; it cannot erase declared
    // native consumers or bypass the contract validation above.
    for (const id of inputs[file] ?? []) selected.add(id);
  }
  return {
    mode: "affected",
    hostValidation: "not-selected",
    reason: "Exact declared inputs with complete selected shared test files",
    selected: Object.fromEntries(jobs.map((id) => [id, selected.has(id)])),
    notSelected: jobs.filter((id) => !selected.has(id)),
    baseline:
      eventName === "pull_request" && baseline?.complete ? baseline : null,
    sharedTestFiles: [
      ...new Set([
        "dist/test/artifact-evidence.test.js",
        "dist/test/ci-impact.test.js",
        "dist/test/ci-development-dependencies.test.js",
        "dist/test/jvm-wrapper-phases.test.js",
        "dist/test/gate-inventory.test.js",
        "dist/test/ci-affected-tests.test.js",
        "dist/test/ci-source-boundaries.test.js",
        "dist/test/ci-full-suite-shards.test.js",
        "dist/test/ci-validation-shards.test.js",
        "dist/test/ci-duration-workflow.test.js",
        ...(changed.some((file) => cProducerSharedInputs.has(file))
          ? producerBoundary.testFiles.map(
              (file) => "dist/" + file.replace(/\.ts$/, ".js"),
            )
          : []),
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
    ["required", "not-selected"].includes(plan.hostValidation),
    "Missing or malformed host validation route",
  );
  if (plan.mode === "full") {
    assert.equal(
      plan.hostValidation,
      "required",
      "Full verification requires host validation",
    );
    assert.equal(plan.dependencyImpact, undefined);
  } else if (plan.hostValidation === "required") {
    const impact = plan.dependencyImpact;
    assert.ok(
      impact && typeof impact === "object" && !Array.isArray(impact),
      "Dependency host route has no typed evidence",
    );
    assert.deepEqual(Object.keys(impact).sort(), [
      "affectedDevelopmentRoots",
      "auditedConsumerFiles",
      "changedLockEntries",
      "declaredBumps",
      "qualifiedLockSha256",
      "scope",
      "sourceInventorySha256",
    ]);
    assert.equal(impact.scope, "audited-development-dependency-consumers-v1");
    assert.ok(
      Array.isArray(impact.declaredBumps) && impact.declaredBumps.length > 0,
    );
    for (const row of impact.declaredBumps) {
      assert.deepEqual(Object.keys(row).sort(), ["after", "before", "name"]);
      assert.ok(["vite", "rolldown"].includes(row.name));
      for (const value of [row.before, row.after])
        assert.match(value, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    }
    for (const field of [
      "affectedDevelopmentRoots",
      "changedLockEntries",
      "auditedConsumerFiles",
    ]) {
      assert.ok(
        Array.isArray(impact[field]) &&
          impact[field].length > 0 &&
          impact[field].every(
            (value) => typeof value === "string" && value.length > 0,
          ),
      );
      assert.equal(new Set(impact[field]).size, impact[field].length);
    }
    for (const field of ["sourceInventorySha256", "qualifiedLockSha256"])
      assert.match(impact[field], /^[a-f0-9]{64}$/);
  } else
    assert.equal(
      plan.dependencyImpact,
      undefined,
      "Dependency plan cannot omit the host queue",
    );
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
    "full-suite-shards",
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
      (id === "full-suite-shards"
        ? plan.mode === "full"
        : id === "host-validation"
          ? plan.hostValidation === "required"
          : plan.selected[id]);
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
    hostValidation: plan.hostValidation,
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
