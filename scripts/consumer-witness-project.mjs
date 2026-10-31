import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parseCapturedProcessOutput } from "../dist/src/process-output.js";
import {
  completeESLintParticipation,
  eslintParticipationTraceSchema,
} from "../dist/src/eslint-participation.js";
import { viteLibraryReceiptSchema } from "../dist/src/vite-library-contract.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const projectConsumerFamilies = Object.freeze([
  "javascript",
  "typescript",
  "shared-json",
]);
export const projectConsumerProfiles = Object.freeze({
  javascript: "consumer-impact",
  typescript: "javascript-extensions",
  "shared-json": "consumer-impact",
});
export const projectConsumerPaths = Object.freeze({
  javascript: [
    "checktrail.json",
    "lib/policy.json",
    "lib/value.js",
    "lib/value.test.js",
    "other/value.test.js",
    "app/value.test.js",
    "site/value.test.js",
    "app/package.json",
    "lib/package.json",
    "other/package.json",
    "site/package.json",
  ],
  "shared-json": [
    "checktrail.json",
    "lib/policy.json",
    "lib/value.js",
    "lib/value.test.js",
    "other/value.test.js",
    "app/value.test.js",
    "site/value.test.js",
    "app/package.json",
    "lib/package.json",
    "other/package.json",
    "site/package.json",
  ],
  typescript: [
    "package.json",
    "checktrail.json",
    "checktrail.javascript.json",
    "esm hook.mjs",
    "cjs hook.cjs",
    "esm.test.mts",
    "cjs.test.cts",
    "lib/index.ts",
    "lib/value.ts",
    "use.ts",
    "processed.js",
    "eslint.config.mjs",
  ],
});
export function projectConsumerScenarios(family, variant) {
  assert.ok(projectConsumerFamilies.includes(family));
  assert.ok(["broken", "fixed", "near-miss"].includes(variant));
  return family === "typescript"
    ? variant === "broken"
      ? [
          "eslint-debugger",
          "esm-sentinel",
          "cjs-sentinel",
          "producer-type",
          "consumer-type",
        ]
      : ["library"]
    : ["workspace"];
}
export function projectConsumerSlots(inventory, family) {
  assert.ok(projectConsumerFamilies.includes(family));
  const slots = inventory.runtimeProfiles
    .filter(
      (runtime) =>
        family !== "typescript" || runtime.id === "native-linux-arm64-node22",
    )
    .map((runtime) => runtime.id);
  assert.ok(slots.length > 0 && new Set(slots).size === slots.length);
  return slots;
}
export function projectConsumerChecks(
  family,
  variant,
  scenario,
  phase = "canonical",
) {
  assert.ok(projectConsumerFamilies.includes(family));
  assert.ok(["broken", "fixed", "near-miss"].includes(variant));
  if (family === "typescript") {
    assert.ok(projectConsumerScenarios(family, variant).includes(scenario));
    assert.equal(phase, "canonical");
    const failed =
      variant === "broken"
        ? scenario === "eslint-debugger"
          ? "javascript.eslint"
          : ["esm-sentinel", "cjs-sentinel"].includes(scenario)
            ? "javascript.node-test"
            : "javascript.vite-library"
        : null;
    return [
      "javascript.node-test",
      "javascript.eslint",
      "javascript.vite-library",
    ].map((id) => ({
      project: ".",
      id,
      status: id === failed ? "failed" : "passed",
      scope:
        id === "javascript.node-test"
          ? ["cjs.test.cts", "esm.test.mts"]
          : id === "javascript.eslint"
            ? projectConsumerPaths.typescript
                .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx|vue)$/.test(file))
                .sort()
            : ["lib/index.ts", "lib/value.ts", "use.ts"],
      tests:
        id === "javascript.node-test"
          ? {
              total: 2,
              passed: id === failed ? 1 : 2,
              failed: id === failed ? 1 : 0,
              skipped: 0,
            }
          : null,
    }));
  }
  assert.ok(
    (scenario === "workspace" && phase === "canonical") ||
      (scenario === "unknown-map" &&
        phase === "repeat" &&
        variant === "broken"),
  );
  const projects =
    family === "javascript" || scenario === "unknown-map"
      ? ["app", "lib", "other", "site"]
      : ["app", "lib", "site"];
  return projects.map((project) => {
    const failed = variant === "broken" && ["app", "site"].includes(project),
      total = project === "other" ? 1 : 2;
    return {
      project,
      id: "javascript.node-test",
      scope: ["value.test.js"],
      status: failed ? "failed" : "passed",
      tests: {
        total,
        passed: failed ? 1 : total,
        failed: failed ? 1 : 0,
        skipped: 0,
      },
    };
  });
}
function source(row, identity) {
  const value = row.before.find((file) => file.path === identity.path);
  assert.ok(value, "Native project receipt names foreign source");
  assert.equal(identity.bytes, value.bytes);
  assert.equal(identity.sha256, value.sha256);
}
/** Accept the observed one-level Node callback wrapper; unrelated test-runner failures never qualify. */
export function requireProjectAssertionFailure(error) {
  const direct =
    error?.name === "AssertionError" && error?.code === "ERR_ASSERTION";
  const wrapped =
    error?.name === "Error" &&
    error?.code === "ERR_TEST_FAILURE" &&
    error?.failureType === "testCodeFailure" &&
    error?.cause?.name === "AssertionError" &&
    error?.cause?.code === "ERR_ASSERTION";
  assert.ok(
    direct || wrapped,
    "Expected boundary failure was replaced by another runtime failure",
  );
}
function nativeNodeSummary(stdout, expectedFileCount) {
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(events.length > 0 && events.length <= 4096);
  const summaries = events.filter((event) => event.type === "test:summary"),
    global = summaries.filter((event) => event.data?.file === undefined),
    files = summaries.filter((event) => typeof event.data?.file === "string");
  assert.equal(
    global.length,
    1,
    "Native Node global summary is missing or duplicated",
  );
  assert.equal(
    files.length,
    expectedFileCount,
    "Native Node file participation differs",
  );
  assert.equal(
    new Set(files.map((event) => event.data.file)).size,
    expectedFileCount,
  );
  const counts = (event) => {
    const value = event.data.counts;
    for (const key of [
      "tests",
      "passed",
      "failed",
      "skipped",
      "todo",
      "cancelled",
    ])
      assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
    assert.equal(value.skipped, 0);
    assert.equal(value.todo, 0);
    assert.equal(value.cancelled, 0);
    assert.equal(value.tests, value.passed + value.failed);
    return {
      total: value.tests,
      passed: value.passed,
      failed: value.failed,
      skipped: 0,
    };
  };
  const total = files.map(counts).reduce(
    (a, b) => ({
      total: a.total + b.total,
      passed: a.passed + b.passed,
      failed: a.failed + b.failed,
      skipped: 0,
    }),
    { total: 0, passed: 0, failed: 0, skipped: 0 },
  );
  assert.deepEqual(counts(global[0]), total);
  return { events, tests: total, files: files.map((event) => event.data.file) };
}
/** Preserve expected native assertion failures as failed processes; only the enclosing frozen callback passes. */
export function inspectProjectNativeCheck(row, index, check, attempt) {
  const expected = projectConsumerChecks(
    row.family,
    row.variant,
    row.project.scenario,
    row.phase,
  )[index];
  assert.ok(expected);
  assert.equal(check.project, expected.project);
  assert.equal(check.id, expected.id);
  assert.equal(check.status, expected.status);
  assert.deepEqual(
    check.scope,
    expected.scope,
    "Original native check source selection differs",
  );
  assert.deepEqual(check.tests ?? null, expected.tests);
  assert.equal(attempt.stage, "consumer");
  assert.equal(
    attempt.executableSha256,
    row.tool.sha256,
    "Native project command executable differs from observed Node",
  );
  assert.equal(attempt.executableAfterSha256, attempt.executableSha256);
  assert.equal(
    attempt.state,
    expected.status,
    "Native expected failure was relabeled or replaced",
  );
  assert.equal(attempt.result.exitCode, expected.status === "failed" ? 1 : 0);
  assert.equal(attempt.result.signal, null);
  assert.equal(attempt.result.errorCode, null);
  assert.equal(attempt.result.timedOut, false);
  assert.equal(attempt.result.cancelled, false);
  assert.equal(attempt.result.truncated, false);
  assert.equal(attempt.cleanupComplete, true);
  assert.equal(attempt.outputState, "complete");
  assert.equal(attempt.identityError, null);
  assert.deepEqual(
    attempt.project,
    {
      scenario: row.project.scenario,
      checkIndex: index,
      reportSha256: hash(JSON.stringify(row.project)),
    },
    "Native project attempt belongs to another report/scenario/check",
  );
  const output = parseCapturedProcessOutput(attempt.output);
  assert.equal(output.completeForObservedStreams, true);
  assert.ok(output.observedBytes <= 1048576);
  const stdout = Buffer.from(output.stdout.base64, "base64").toString("utf8");
  assert.ok(stdout.length > 0);
  if (check.id === "javascript.node-test") {
    const node = nativeNodeSummary(stdout, row.family === "typescript" ? 2 : 1);
    assert.deepEqual(node.tests, expected.tests);
    for (const file of expected.scope)
      assert.equal(
        node.files.filter((actual) =>
          actual
            .replaceAll("\\", "/")
            .endsWith(
              "/" + (check.project === "." ? "" : check.project + "/") + file,
            ),
        ).length,
        1,
        "Native file summary belongs to another project/source",
      );
    if (row.family === "typescript") {
      const markers = node.events.filter(
        (event) => event.type === "checktrail:node-loaders",
      );
      assert.equal(markers.length, 2);
      assert.equal(node.events[0], markers[0]);
      assert.equal(node.events.at(-1), markers[1]);
      assert.equal(markers[0].phase, "start");
      assert.equal(markers[1].phase, "end");
      assert.deepEqual(markers[0].manifest, markers[1].manifest);
      assert.equal(markers[0].runtime, row.runtime.node);
      assert.equal(markers[1].runtime, row.runtime.node);
      const manifest = markers[0].manifest;
      assert.equal(manifest.sourceFingerprint, row.project.sourceFingerprint);
      assert.equal(manifest.runtime, row.runtime.node);
      assert.deepEqual(manifest.files.map((file) => file.path).sort(), [
        "cjs.test.cts",
        "esm.test.mts",
      ]);
      assert.deepEqual(
        manifest.loaders.map((loader) => [loader.kind, loader.path]),
        [
          ["require", "cjs hook.cjs"],
          ["import", "esm hook.mjs"],
        ],
      );
      for (const file of manifest.files) source(row, file);
      for (const loader of manifest.loaders)
        assert.equal(
          loader.sha256,
          row.before.find((file) => file.path === loader.path)?.sha256,
        );
    }
    const names =
      row.family === "typescript"
        ? [
            "ESM loader rewrites the sentinel",
            "CJS loader rewrites the sentinel",
          ]
        : check.project === "other"
          ? null
          : check.project === "lib"
            ? ["producer scoped grant", "producer plain grant"]
            : [
                check.project + " exact boundary",
                check.project + " valid family",
              ];
    if (names)
      for (const name of names) {
        const failed =
          expected.status === "failed" &&
          (row.family === "typescript"
            ? row.project.scenario === "esm-sentinel"
              ? name.startsWith("ESM")
              : name.startsWith("CJS")
            : name.endsWith("exact boundary"));
        const outcomes = node.events.filter(
          (event) =>
            event.type === (failed ? "test:fail" : "test:pass") &&
            event.data?.name === name,
        );
        assert.equal(
          outcomes.length,
          1,
          "Original native consumer assertion was not reached exactly once",
        );
        if (failed)
          requireProjectAssertionFailure(outcomes[0].data.details?.error);
      }
  } else if (check.id === "javascript.eslint") {
    const native = JSON.parse(stdout);
    assert.equal(native.schemaVersion, 2);
    assert.equal(native.toolVersion, "10.11.0");
    assert.equal(native.sourceFingerprint, row.project.sourceFingerprint);
    source(row, native.configuration);
    assert.ok(Array.isArray(native.files) && native.files.length > 0);
    const processed = native.files.find((file) => file.path === "processed.js");
    assert.ok(processed);
    assert.equal(
      processed.results[0].errorCount,
      expected.status === "failed" ? 2 : 0,
    );
    assert.equal(processed.participation.complete, true);
    assert.equal(
      processed.participation.events.filter((event) => event.kind === "parse")
        .length,
      2,
    );
    assert.deepEqual(
      native.files.map((file) => file.path).sort(),
      [...check.scope].sort(),
    );
    for (const file of native.files) {
      source(row, file.source);
      assert.equal(file.configured, true);
      assert.ok(file.activeRules > 0);
      assert.equal(
        completeESLintParticipation(
          file.source,
          eslintParticipationTraceSchema.parse(file.participation),
        ),
        true,
      );
      for (const result of file.results) {
        assert.equal(result.warningCount, 0);
        assert.equal(result.fatalErrorCount, 0);
        assert.equal(
          result.errorCount,
          expected.status === "failed" && file.path === "processed.js" ? 2 : 0,
        );
        if (result.errorCount) {
          assert.equal(result.messages.length, 2);
          assert.ok(
            result.messages.every(
              (message) =>
                message.ruleId === "no-debugger" && message.severity === 2,
            ),
          );
        }
      }
    }
  } else {
    assert.equal(check.id, "javascript.vite-library");
    const native = viteLibraryReceiptSchema.parse(JSON.parse(stdout));
    assert.equal(
      native.manifest.sourceFingerprint,
      row.project.sourceFingerprint,
    );
    for (const file of [
      ...native.manifest.sources,
      ...native.manifest.consumers,
    ])
      source(row, file);
    assert.deepEqual(native.versions, {
      vite: "8.3.0",
      rolldown: "1.2.9",
      typescript: "6.0.3",
    });
    if (expected.status === "failed") {
      const expectedFile =
        row.project.scenario === "producer-type" ? "lib/value.ts" : "use.ts";
      assert.ok(
        native.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 2322 &&
            typeof diagnostic.file === "string" &&
            diagnostic.file.replaceAll("\\", "/").endsWith("/" + expectedFile),
        ),
        "Original native TS2322 producer/consumer contract failure is missing",
      );
    } else {
      assert.equal(native.complete, true);
      assert.equal(native.diagnostics.length, 0);
      assert.ok(native.declarations.length > 0);
      for (const file of native.manifest.sources)
        assert.equal(
          native.producerFiles.filter((actual) =>
            actual.replaceAll("\\", "/").endsWith("/" + file.path),
          ).length,
          1,
        );
      for (const file of native.manifest.consumers)
        assert.ok(
          native.consumerFiles.some((actual) =>
            actual.replaceAll("\\", "/").endsWith("/" + file.path),
          ),
        );
      for (const artifact of native.declarations)
        assert.ok(artifact.bytes > 0 && sha(artifact.sha256));
      assert.deepEqual(native.builds.map((build) => build.format).sort(), [
        "cjs",
        "es",
      ]);
      for (const build of native.builds) {
        assert.equal(build.chunks.length, 1);
        assert.equal(build.modules.length, native.manifest.sources.length);
        for (const file of native.manifest.sources)
          assert.equal(
            build.modules.filter((actual) =>
              actual.replaceAll("\\", "/").endsWith("/" + file.path),
            ).length,
            1,
          );
        const chunk = build.chunks[0];
        assert.ok(
          chunk.entry
            .replaceAll("\\", "/")
            .endsWith("/" + native.manifest.profile.entry),
        );
        assert.deepEqual(chunk.exports, ["value"]);
        assert.ok(chunk.artifact.bytes > 0 && sha(chunk.artifact.sha256));
        assert.deepEqual(chunk.imports, []);
        assert.deepEqual(chunk.dynamicImports, []);
      }
      assert.ok(
        native.resolutions.some(
          (resolution) =>
            resolution.consumer.endsWith("/use.ts") ||
            resolution.consumer.endsWith("\\use.ts"),
        ),
      );
    }
  }
  return expected;
}
export function inspectProjectWitness(row, attemptValues) {
  assert.ok(projectConsumerFamilies.includes(row.family));
  assert.equal(row.profile, "native-project-consumer-witness-observation-v1");
  const value = row.project;
  assert.ok(value);
  assert.equal(
    value.evidenceClass,
    "controller-source-bound-native-project-reports",
  );
  assert.equal(value.applicationSemanticsVerified, false);
  assert.equal(value.nativeModuleLoadsTraced, false);
  assert.equal(
    value.sourceBinding,
    "actual-controller-files-and-native-report",
  );
  assert.ok(sha(value.sourceFingerprint));
  assert.equal(value.finalSourceFingerprint, value.sourceFingerprint);
  assert.equal(value.sourceChanged, false);
  assert.equal(value.sourceError, false);
  assert.deepEqual(row.after, row.before);
  assert.deepEqual(
    row.before.map((file) => file.path),
    projectConsumerPaths[row.family],
  );
  const expected = projectConsumerChecks(
    row.family,
    row.variant,
    value.scenario,
    row.phase,
  );
  assert.equal(value.outcome, row.variant === "broken" ? "failed" : "passed");
  assert.equal(value.checks.length, expected.length);
  assert.equal(attemptValues.length, expected.length);
  assert.equal(
    new Set(attemptValues.map((value) => value.attemptId)).size,
    expected.length,
    "Native project process attempt reused",
  );
  if (row.family !== "typescript")
    assert.equal(
      value.selectionMode,
      row.family === "javascript"
        ? null
        : value.scenario === "unknown-map"
          ? "full"
          : "affected",
    );
  for (const [index, check] of value.checks.entries())
    inspectProjectNativeCheck(row, index, check, attemptValues[index]);
}
export function projectConsumerObservationKey(row) {
  return JSON.stringify([
    row.family,
    row.variant,
    row.origin,
    row.runtime.slot,
    row.project.scenario,
  ]);
}
export function projectConsumerRequiredKeys(inventory, family) {
  return projectConsumerSlots(inventory, family).flatMap((slot) =>
    ["broken", "fixed", "near-miss"].flatMap((variant) =>
      ["source", "installed"].flatMap((origin) =>
        projectConsumerScenarios(family, variant).map((scenario) => ({
          family,
          variant,
          origin,
          slot,
          scenario,
        })),
      ),
    ),
  );
}
export function projectConsumerLogicalWitnesses(inventory, family) {
  return projectConsumerSlots(inventory, family).flatMap((slot) =>
    ["broken", "fixed", "near-miss"].flatMap((variant) =>
      ["source", "installed"].map((origin) => ({
        family,
        variant,
        origin,
        slot,
        scenarios: projectConsumerScenarios(family, variant),
      })),
    ),
  );
}
export function inspectProjectAttempt(value) {
  if (!projectConsumerFamilies.includes(value.family)) {
    assert.ok(value.project === undefined || value.project === null);
    return;
  }
  assert.equal(value.stage, "consumer");
  assert.ok(value.project && typeof value.project.scenario === "string");
  projectConsumerChecks(
    value.family,
    value.variant,
    value.project.scenario,
    value.phase,
  );
  assert.ok(
    Number.isSafeInteger(value.project.checkIndex) &&
      value.project.checkIndex >= 0 &&
      value.project.checkIndex < 64,
  );
  assert.ok(sha(value.project.reportSha256));
}
