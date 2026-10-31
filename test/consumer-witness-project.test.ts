import assert from "node:assert/strict";
import { ZodError } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.js";
import { test } from "node:test";
const {
  projectConsumerPaths,
  projectConsumerScenarios,
  projectConsumerSlots,
  projectConsumerChecks,
  projectConsumerRequiredKeys,
  projectConsumerLogicalWitnesses,
  inspectProjectWitness,
  inspectProjectNativeCheck,
  requireProjectAssertionFailure,
} = await import(
  new URL("../../scripts/consumer-witness-project.mjs", import.meta.url).href
);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Family = "javascript" | "shared-json" | "typescript";
type Counts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};
type Check = {
  project: string;
  id: string;
  status: string;
  tests: Counts | null;
  scope: string[];
};
const physical = (text: string) => ({
  base64: Buffer.from(text).toString("base64"),
  bytes: Buffer.byteLength(text),
  sha256: hash(text),
});
const output = (text: string) => ({
  profile: "bounded-physical-process-output-v1",
  stdout: physical(text),
  stderr: physical(""),
  observedBytes: Buffer.byteLength(text),
  completeForObservedStreams: true,
});
/** All payloads here are synthetic. No actual project/native process is executed by this factory. */
function sample(
  family: Family,
  variant = "broken",
  scenario: string = projectConsumerScenarios(family, variant)[0],
  phase = "canonical",
) {
  const paths: string[] = projectConsumerPaths[family],
    before = paths.map((path) => ({
      path,
      bytes: Buffer.byteLength("synthetic:" + path),
      sha256: hash("synthetic:" + path),
    }));
  const checks: Check[] = projectConsumerChecks(
    family,
    variant,
    scenario,
    phase,
  );
  const row = {
    profile: "native-project-consumer-witness-observation-v1",
    family,
    variant,
    origin: "source",
    phase,
    before,
    after: structuredClone(before),
    runtime: { node: "22.23.2", slot: "native-linux-arm64-node22" },
    tool: { sha256: hash("synthetic-node-binary") },
    project: {
      evidenceClass: "controller-source-bound-native-project-reports",
      applicationSemanticsVerified: false,
      nativeModuleLoadsTraced: false,
      sourceBinding: "actual-controller-files-and-native-report",
      sourceFingerprint: hash("synthetic-fingerprint"),
      finalSourceFingerprint: hash("synthetic-fingerprint"),
      sourceChanged: false,
      sourceError: false,
      outcome: variant === "broken" ? "failed" : "passed",
      selectionMode:
        family === "typescript" || family === "javascript"
          ? null
          : scenario === "unknown-map"
            ? "full"
            : "affected",
      scenario,
      checks,
    },
  };
  const identity = (path: string) => {
    const value = before.find((file) => file.path === path);
    assert.ok(value);
    return value;
  };
  const attempts = checks.map((check, index) => {
    let stdout: string;
    if (check.id === "javascript.node-test") {
      const names =
        family === "typescript"
          ? [
              "CJS loader rewrites the sentinel",
              "ESM loader rewrites the sentinel",
            ]
          : check.project === "other"
            ? ["original passing test"]
            : check.project === "lib"
              ? ["producer scoped grant", "producer plain grant"]
              : [
                  check.project + " exact boundary",
                  check.project + " valid family",
                ];
      const outcomes = names.map((name) => {
        const failed =
          check.status === "failed" &&
          (family === "typescript"
            ? scenario === "esm-sentinel"
              ? name.startsWith("ESM")
              : name.startsWith("CJS")
            : name.endsWith("exact boundary"));
        return {
          type: failed ? "test:fail" : "test:pass",
          data: {
            name,
            details: {
              error: failed
                ? {
                    name: "Error",
                    code: "ERR_TEST_FAILURE",
                    failureType: "testCodeFailure",
                    cause: { name: "AssertionError", code: "ERR_ASSERTION" },
                  }
                : null,
            },
          },
        };
      });
      const summary = (
        file: string | undefined,
        total: number,
        failed: number,
      ) => ({
        type: "test:summary",
        data: {
          ...(file ? { file } : {}),
          counts: {
            tests: total,
            passed: total - failed,
            failed,
            skipped: 0,
            todo: 0,
            cancelled: 0,
          },
        },
      });
      const fileSummaries =
        family === "typescript"
          ? check.scope.map((file, i) =>
              summary(
                "/synthetic/" + file,
                1,
                outcomes[i]!.type === "test:fail" ? 1 : 0,
              ),
            )
          : [
              summary(
                "/synthetic/" + check.project + "/value.test.js",
                check.tests!.total,
                check.tests!.failed,
              ),
            ];
      const events = [
        ...outcomes,
        ...fileSummaries,
        summary(undefined, check.tests!.total, check.tests!.failed),
      ];
      if (family === "typescript") {
        const manifest = {
          schemaVersion: 1,
          sourceFingerprint: row.project.sourceFingerprint,
          runtime: row.runtime.node,
          files: [identity("cjs.test.cts"), identity("esm.test.mts")],
          loaders: [
            {
              kind: "require",
              path: "cjs hook.cjs",
              sha256: identity("cjs hook.cjs").sha256,
            },
            {
              kind: "import",
              path: "esm hook.mjs",
              sha256: identity("esm hook.mjs").sha256,
            },
          ],
        };
        stdout =
          [
            {
              type: "checktrail:node-loaders",
              phase: "start",
              manifest,
              runtime: row.runtime.node,
            },
            ...events,
            {
              type: "checktrail:node-loaders",
              phase: "end",
              manifest: structuredClone(manifest),
              runtime: row.runtime.node,
            },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n";
      } else
        stdout = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    } else if (check.id === "javascript.eslint") {
      const files = check.scope.map((path) => {
        const source = identity(path),
          processed = path === "processed.js",
          failed = processed && check.status === "failed",
          parse = (input: typeof source) => ({
            kind: "parse",
            input,
            successful: true,
            activeRules: 1,
          });
        const children = [
          { path: "synthetic-first.ts", bytes: 1, sha256: hash("a") },
          { path: "synthetic-second.ts", bytes: 1, sha256: hash("b") },
        ];
        return {
          path,
          source,
          configured: true,
          activeRules: 1,
          processorUsed: processed,
          participation: {
            complete: true,
            events: processed
              ? [
                  {
                    kind: "preprocess",
                    id: 0,
                    input: source,
                    outputs: children,
                  },
                  ...children.map(parse),
                  { kind: "postprocess", id: 0 },
                ]
              : [parse(source)],
          },
          results: [
            {
              errorCount: failed ? 2 : 0,
              warningCount: 0,
              fatalErrorCount: 0,
              messages: failed
                ? [
                    { ruleId: "no-debugger", severity: 2 },
                    { ruleId: "no-debugger", severity: 2 },
                  ]
                : [],
            },
          ],
        };
      });
      stdout = JSON.stringify({
        schemaVersion: 2,
        toolVersion: "10.13.0",
        sourceFingerprint: row.project.sourceFingerprint,
        configuration: identity("eslint.config.mjs"),
        files,
      });
    } else {
      const failed = check.status === "failed",
        artifact = { path: "value.js", bytes: 8, sha256: hash("artifact") };
      stdout = JSON.stringify({
        schemaVersion: 1,
        manifest: {
          schemaVersion: 1,
          sourceFingerprint: row.project.sourceFingerprint,
          profile: {
            sourceDirectory: "lib",
            entry: "lib/index.ts",
            consumers: ["use.ts"],
          },
          sources: [identity("lib/index.ts"), identity("lib/value.ts")],
          consumers: [identity("use.ts")],
        },
        versions: { vite: "8.3.0", rolldown: "1.2.9", typescript: "6.0.3" },
        complete: !failed,
        producerFiles: ["/synthetic/lib/index.ts", "/synthetic/lib/value.ts"],
        consumerFiles: ["/synthetic/use.ts"],
        resolutions: [
          {
            consumer: "/synthetic/use.ts",
            declaration: "/synthetic/generated/index.d.ts",
          },
        ],
        diagnostics: failed
          ? [
              {
                code: 2322,
                message: "Original synthetic type mismatch",
                file:
                  "/synthetic/" +
                  (scenario === "producer-type" ? "lib/value.ts" : "use.ts"),
              },
            ]
          : [],
        declarations: failed ? [] : [{ ...artifact, path: "index.d.ts" }],
        builds: failed
          ? []
          : ["es", "cjs"].map((format) => ({
              format,
              modules: ["/synthetic/lib/index.ts", "/synthetic/lib/value.ts"],
              chunks: [
                {
                  artifact,
                  exports: ["value"],
                  entry: "/synthetic/lib/index.ts",
                  imports: [],
                  dynamicImports: [],
                },
              ],
            })),
      });
    }
    return {
      attemptId: randomUUID(),
      executableSha256: row.tool.sha256,
      executableAfterSha256: row.tool.sha256,
      stage: "consumer",
      state: check.status,
      result: {
        exitCode: check.status === "failed" ? 1 : 0,
        signal: null,
        errorCode: null,
        timedOut: false,
        cancelled: false,
        truncated: false,
      },
      cleanupComplete: true,
      outputState: "complete",
      identityError: null,
      project: {
        scenario,
        checkIndex: index,
        reportSha256: hash(JSON.stringify(row.project)),
      },
      output: output(stdout),
    };
  });
  return { row, attempts };
}
test("synthetic project witnesses preserve actual expected failed states and every original full and selected consumer", () => {
  for (const family of ["javascript", "shared-json"] as const)
    for (const variant of ["broken", "fixed", "near-miss"]) {
      const { row, attempts } = sample(family, variant);
      inspectProjectWitness(row, attempts);
      assert.equal(attempts.length, family === "javascript" ? 4 : 3);
      assert.equal(
        attempts.filter((value) => value.state === "failed").length,
        variant === "broken" ? 2 : 0,
      );
    }
  for (const family of ["javascript", "shared-json"] as const) {
    const { row, attempts } = sample(family, "broken", "unknown-map", "repeat");
    inspectProjectWitness(row, attempts);
    assert.equal(attempts.length, 4);
    if (family === "shared-json")
      assert.equal(row.project.selectionMode, "full");
  }
});
test("synthetic TypeScript project witnesses retain all five original broken scenarios and source-bound loader lint declaration and consumer outputs", () => {
  for (const variant of ["broken", "fixed", "near-miss"])
    for (const scenario of projectConsumerScenarios("typescript", variant)) {
      const { row, attempts } = sample("typescript", variant, scenario);
      inspectProjectWitness(row, attempts);
      assert.equal(attempts.length, 3);
      assert.equal(
        attempts.filter((value) => value.state === "failed").length,
        variant === "broken" ? 1 : 0,
      );
    }
});
test("native project expected failures cannot be relabeled passed or replaced by unavailable skipped cancelled syntax and foreign-source observations", () => {
  const { row, attempts } = sample("javascript");
  for (const mutate of [
    (value: (typeof attempts)[number]) => {
      value.state = "passed";
    },
    (value: (typeof attempts)[number]) => {
      value.result.exitCode = 2;
    },
    (value: (typeof attempts)[number]) => {
      value.result.cancelled = true;
    },
    (value: (typeof attempts)[number]) => {
      value.outputState = "unavailable";
    },
    (value: (typeof attempts)[number]) => {
      value.project.checkIndex = 1;
    },
  ]) {
    const value = structuredClone(attempts[0]!);
    mutate(value);
    assert.throws(() =>
      inspectProjectNativeCheck(row, 0, row.project.checks[0], value),
    );
  }
  const wrong = structuredClone(attempts[0]!),
    events = Buffer.from(wrong.output.stdout.base64, "base64")
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  events[0].data.details.error.code = "ERR_MODULE_NOT_FOUND";
  wrong.output = output(
    events.map((value) => JSON.stringify(value)).join("\n"),
  );
  assert.throws(
    () => inspectProjectNativeCheck(row, 0, row.project.checks[0], wrong),
    /replaced by another runtime failure/,
  );
  const missing = structuredClone(row);
  missing.project.checks.pop();
  assert.throws(() => inspectProjectWitness(missing, attempts));
  const reused = structuredClone(attempts);
  reused[1]!.attemptId = reused[0]!.attemptId;
  assert.throws(() => inspectProjectWitness(row, reused), /attempt reused/);
  const skipped = structuredClone(attempts[0]!),
    native = Buffer.from(skipped.output.stdout.base64, "base64")
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  native.at(-1).data.counts.skipped = 1;
  skipped.output = output(
    native.map((value) => JSON.stringify(value)).join("\n"),
  );
  assert.throws(() =>
    inspectProjectNativeCheck(row, 0, row.project.checks[0], skipped),
  );
});
test("native TypeScript project source and artifact identities reject changed hooks missing participation wrong diagnostic roles and missing produced exports", () => {
  const loader = sample("typescript", "broken", "esm-sentinel"),
    attempt = structuredClone(loader.attempts[0]!);
  const events = Buffer.from(attempt.output.stdout.base64, "base64")
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  events[0].manifest.loaders[0].sha256 = hash("foreign");
  events.at(-1).manifest = structuredClone(events[0].manifest);
  attempt.output = output(
    events.map((value) => JSON.stringify(value)).join("\n"),
  );
  assert.throws(() =>
    inspectProjectNativeCheck(
      loader.row,
      0,
      loader.row.project.checks[0],
      attempt,
    ),
  );
  const lint = sample("typescript", "broken", "eslint-debugger"),
    missing = structuredClone(lint.attempts[1]!);
  const native = JSON.parse(
    Buffer.from(missing.output.stdout.base64, "base64").toString(),
  );
  native.files
    .find((file: { path: string }) => file.path === "processed.js")
    .participation.events.splice(1, 1);
  missing.output = output(JSON.stringify(native));
  assert.throws(() =>
    inspectProjectNativeCheck(lint.row, 1, lint.row.project.checks[1], missing),
  );
  const producer = sample("typescript", "broken", "producer-type"),
    wrong = structuredClone(producer.attempts[2]!),
    diagnostic = JSON.parse(
      Buffer.from(wrong.output.stdout.base64, "base64").toString(),
    );
  diagnostic.diagnostics[0].file = "/synthetic/use.ts";
  wrong.output = output(JSON.stringify(diagnostic));
  assert.throws(
    () =>
      inspectProjectNativeCheck(
        producer.row,
        2,
        producer.row.project.checks[2],
        wrong,
      ),
    /producer\/consumer contract/,
  );
  const fixed = sample("typescript", "fixed"),
    artifact = structuredClone(fixed.attempts[2]!),
    build = JSON.parse(
      Buffer.from(artifact.output.stdout.base64, "base64").toString(),
    );
  build.builds[1].chunks[0].exports = [];
  artifact.output = output(JSON.stringify(build));
  assert.throws(() =>
    inspectProjectNativeCheck(
      fixed.row,
      2,
      fixed.row.project.checks[2],
      artifact,
    ),
  );
});
test("project witness scope enumerates every selected engine runtime and all original TypeScript scenarios before completeness can be considered", async () => {
  const inventory = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const family of ["javascript", "shared-json"]) {
    assert.deepEqual(
      projectConsumerSlots(inventory, family),
      inventory.runtimeProfiles.map((row: { id: string }) => row.id),
    );
    assert.equal(
      projectConsumerRequiredKeys(inventory, family).length,
      inventory.runtimeProfiles.length * 6,
    );
    assert.equal(
      projectConsumerLogicalWitnesses(inventory, family).length,
      inventory.runtimeProfiles.length * 6,
    );
  }
  assert.deepEqual(projectConsumerSlots(inventory, "typescript"), [
    "native-linux-arm64-node22",
  ]);
  assert.equal(projectConsumerRequiredKeys(inventory, "typescript").length, 14);
  assert.equal(
    projectConsumerLogicalWitnesses(inventory, "typescript").length,
    6,
  );
  assert.throws(() => projectConsumerChecks("typescript", "broken", "library"));
  assert.throws(() =>
    projectConsumerChecks("shared-json", "fixed", "unknown-map", "repeat"),
  );
});

const {
  inspectConsumerWitnesses,
  requireQualifiedConsumerWitnessSlot,
  requireQualifiedConsumerWitnessFamily,
} = await import(
  new URL("../../scripts/consumer-witness-evidence.mjs", import.meta.url).href
);
const { inspectConsumerAttemptRecords } = await import(
  new URL("../../scripts/consumer-witness-attempts.mjs", import.meta.url).href
);
/** Synthetic complete envelopes exercise reconciliation, never replace actual runtime/controller acceptance. */
function envelope(
  family: Family,
  variant: string,
  origin: string,
  slot: { id: string; node: string; platform: string; architecture: string },
  scenario: string,
) {
  const base = sample(family, variant, scenario),
    witnessId = randomUUID();
  const code = {
    engineSha256: hash("engine"),
    harnessSha256: hash("harness"),
    requirementsSha256: hash("requirements"),
    acceptanceSha256: hash("acceptance"),
    packageManifestSha256: hash("package"),
    installedOutsidePackage: origin === "installed",
  };
  const attempts = [];
  const row = {
    ...base.row,
    schemaVersion: 1,
    witnessId,
    origin,
    attempts: [] as {
      stage: string;
      attemptId: string;
      file: string;
      bytes: number;
      sha256: string;
    }[],
    code,
    tool: {
      name: "node",
      bytes: 32,
      ...base.row.tool,
      afterSha256: base.row.tool.sha256,
    },
    runtime: {
      ...base.row.runtime,
      slot: slot.id,
      node: slot.node,
      platform: slot.platform,
      architecture: slot.architecture,
      nodeExecutableSha256: base.row.tool.sha256,
      distributionSha256:
        slot.platform === "linux" ? hash("distribution") : null,
    },
    nativeInvoked: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
    compiler: null,
    compilerLink: null,
    jvm: null,
    managed: null,
    swift: null,
    output: base.attempts.at(-1)!.output,
    invocation: {
      commandSha256: hash("last-command"),
      argvSha256: hash("last-argv"),
      executableSha256: base.row.tool.sha256,
      executableAfterSha256: base.row.tool.sha256,
      ...base.attempts.at(-1)!.result,
      cleanupComplete: true,
    },
  };
  for (const [index, attempt] of base.attempts.entries()) {
    const last = index === base.attempts.length - 1;
    const value = {
      ...attempt,
      schemaVersion: 1,
      profile: "consumer-process-result-observation-v1",
      witnessId,
      family,
      variant,
      origin,
      phase: row.phase,
      before: row.before,
      after: row.after,
      commandSha256: last
        ? row.invocation.commandSha256
        : hash("command:" + index),
      argvSha256: last ? row.invocation.argvSha256 : hash("argv:" + index),
      result: { ...attempt.result, durationMs: 1 },
      processStartAcknowledgementRetained: false,
      nativeTerminalObserved: true,
      gateAComplete: false,
    };
    const bytes = Buffer.from(JSON.stringify(value) + "\n"),
      stored = {
        file: "attempt-" + value.attemptId + ".json",
        bytes: bytes.length,
        sha256: hash(bytes.toString()),
        value,
      };
    attempts.push(stored);
    row.attempts.push({
      stage: "consumer",
      attemptId: value.attemptId,
      file: stored.file,
      bytes: stored.bytes,
      sha256: stored.sha256,
    });
  }
  const binding = {
    family,
    variant,
    origin,
    scenario,
    slot: slot.id,
    ...code,
    toolInputsSha256: hash("tools:" + slot.id),
    toolExecutableSha256: row.tool.sha256,
    toolVersionMatched: true,
    observationSha256: hash(JSON.stringify(row)),
    runtimeImage:
      slot.id === "native-linux-arm64-node22"
        ? {
            kind: "oci-image-observation",
            id: "sha256:" + hash("image"),
            definitionSha256: hash("definition"),
          }
        : {
            kind: "hosted-runner-metadata",
            imageOS:
              slot.platform === "darwin"
                ? "macos26"
                : slot.platform === "win32"
                  ? "win25"
                  : "ubuntu24",
            imageVersion: "20261030.1.0",
            distributionSha256: row.runtime.distributionSha256,
            metadataAttested: false,
          },
    complete: true,
    skipped: false,
    hostAttestationPerformed: false,
  };
  return { row, attempts, binding };
}
async function projectScope() {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(new URL("../../" + name, import.meta.url), "utf8"),
    );
  const manifest = await read("docs/gate-a-consumer-witnesses.v1.json"),
    inventory = await read("docs/gate-a-profiles.v1.json"),
    profiles = await read("scripts/required-native-tests.json");
  for (const family of manifest.families)
    if (["javascript", "typescript", "shared-json"].includes(family.id)) {
      family.collectorImplementation = "prepared";
      family.sourcePaths = projectConsumerPaths[family.id];
    }
  return { manifest, inventory, profiles };
}
test("synthetic project reconciliation qualifies only a complete selected slot and keeps every other matrix scope missing", async () => {
  const { manifest, inventory, profiles } = await projectScope(),
    slot = inventory.runtimeProfiles.find(
      (slot: { id: string }) => slot.id === "native-linux-arm64-node22",
    );
  const packets = ["broken", "fixed", "near-miss"].flatMap((variant) =>
    ["source", "installed"].map((origin) =>
      envelope("javascript", variant, origin, slot, "workspace"),
    ),
  );
  const inspect = (rows = packets) =>
    inspectConsumerWitnesses(
      manifest,
      inventory,
      profiles,
      rows.map((packet) => packet.row),
      rows.map((packet) => packet.binding),
      rows.flatMap((packet) => packet.attempts),
    );
  const report = inspect();
  assert.equal(report.complete, false);
  assert.deepEqual(report.issues, []);
  const family = report.families.find(
    (row: { family: string }) => row.family === "javascript",
  );
  assert.equal(family.requiredWitnesses, inventory.runtimeProfiles.length * 6);
  assert.equal(family.observedWitnesses, 6);
  assert.equal(family.complete, false);
  assert.equal(
    requireQualifiedConsumerWitnessSlot(report, "javascript", slot.id).complete,
    true,
  );
  assert.throws(() =>
    requireQualifiedConsumerWitnessFamily(report, "javascript"),
  );
  assert.throws(
    () =>
      requireQualifiedConsumerWitnessSlot(
        inspect(packets.slice(1)),
        "javascript",
        slot.id,
      ),
    /incomplete/,
  );
  const wrong = structuredClone(packets);
  wrong[0]!.binding.slot = inventory.runtimeProfiles[0].id;
  assert.ok(inspect(wrong).issues.includes("unmatched-controller-binding"));
});
test("synthetic complete project matrix retains all runtime variants five TypeScript scenarios and per-scenario source installed identities", async () => {
  const { manifest, inventory, profiles } = await projectScope();
  const packets = (
    ["javascript", "shared-json", "typescript"] as const
  ).flatMap((family) =>
    inventory.runtimeProfiles
      .filter((slot: { id: string }) =>
        projectConsumerSlots(inventory, family).includes(slot.id),
      )
      .flatMap(
        (slot: {
          id: string;
          node: string;
          platform: string;
          architecture: string;
        }) =>
          ["broken", "fixed", "near-miss"].flatMap((variant) =>
            ["source", "installed"].flatMap((origin) =>
              projectConsumerScenarios(family, variant).map(
                (scenario: string) =>
                  envelope(family, variant, origin, slot, scenario),
              ),
            ),
          ),
      ),
  );
  const inspect = (rows = packets) =>
    inspectConsumerWitnesses(
      manifest,
      inventory,
      profiles,
      rows.map((packet) => packet.row),
      rows.map((packet) => packet.binding),
      rows.flatMap((packet) => packet.attempts),
    );
  const report = inspect();
  assert.deepEqual(report.issues, []);
  assert.equal(report.complete, false);
  for (const family of ["javascript", "shared-json", "typescript"]) {
    const qualified = report.families.find(
      (row: { family: string }) => row.family === family,
    );
    assert.equal(qualified.complete, true);
    assert.equal(
      qualified.requiredObservations,
      family === "typescript" ? 14 : inventory.runtimeProfiles.length * 6,
    );
  }
  const missing = packets.filter(
    (packet) =>
      !(
        packet.row.family === "typescript" &&
        packet.row.variant === "broken" &&
        packet.row.origin === "installed" &&
        packet.row.project.scenario === "consumer-type"
      ),
  );
  assert.equal(
    inspect(missing).families.find(
      (row: { family: string }) => row.family === "typescript",
    ).complete,
    false,
  );
  const drift = structuredClone(packets),
    target = drift.find(
      (packet) =>
        packet.row.family === "typescript" &&
        packet.row.variant === "broken" &&
        packet.row.origin === "installed" &&
        packet.row.project.scenario === "consumer-type",
    )!;
  target.binding.toolInputsSha256 = hash("different-sdk");
  const refused = inspect(drift);
  assert.ok(refused.issues.includes("source-installed-identity-mismatch"));
  assert.throws(() =>
    requireQualifiedConsumerWitnessSlot(
      refused,
      "typescript",
      "native-linux-arm64-node22",
    ),
  );
});
test("bounded global attempt inventory can retain the complete multi-runtime family scope beyond one local namespace", () => {
  const slot = {
    id: "native-linux-arm64-node22",
    node: "22.23.2",
    platform: "linux",
    architecture: "arm64",
  };
  const records = Array.from({ length: 130 }, () =>
    envelope("javascript", "fixed", "source", slot, "workspace"),
  ).flatMap((packet) => packet.attempts);
  assert.equal(records.length, 520);
  assert.equal(inspectConsumerAttemptRecords(records).records.size, 520);
  assert.throws(
    () =>
      inspectConsumerAttemptRecords(
        Array.from(
          { length: 2050 },
          (_, index) => records[index % records.length],
        ),
      ),
    /inventory exceeds bound/,
  );
});

test("unselected native project runtime observations remain explicitly unqualified even beside a selected slot", async () => {
  const { manifest, inventory, profiles } = await projectScope();
  const slot = inventory.runtimeProfiles.find(
    (row: { id: string }) => row.id === "native-linux-arm64-node22",
  );
  const packet = envelope("javascript", "fixed", "source", slot, "workspace");
  const row = { ...packet.row, runtime: { ...packet.row.runtime, slot: null } };
  const binding = {
    ...packet.binding,
    slot: null,
    observationSha256: hash(JSON.stringify(row)),
  };
  const report = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    [row],
    [binding],
    packet.attempts,
  );
  assert.deepEqual(report.issues, []);
  const family = report.families.find(
    (row: { family: string }) => row.family === "javascript",
  );
  assert.equal(family.complete, false);
  assert.equal(family.observedWitnesses, 0);
  assert.deepEqual(family.unqualified, [
    {
      variant: "fixed",
      origin: "source",
      slot: null,
      scenario: "workspace",
      reason: "unselected-native-runtime",
    },
  ]);
});

test("native assertion callbacks qualify only direct assertions or the precise one-level Node wrapper across consumer and ESM CJS scenarios", () => {
  requireProjectAssertionFailure({
    name: "AssertionError",
    code: "ERR_ASSERTION",
  });
  for (const [family, scenario] of [
    ["javascript", "workspace"],
    ["shared-json", "workspace"],
    ["typescript", "esm-sentinel"],
    ["typescript", "cjs-sentinel"],
  ] as const) {
    const { row, attempts } = sample(family, "broken", scenario);
    inspectProjectNativeCheck(row, 0, row.project.checks[0], attempts[0]);
    for (const error of [
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "subtestsFailed",
        cause: { name: "AssertionError", code: "ERR_ASSERTION" },
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: { name: "SyntaxError" },
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: { name: "Error", code: "ERR_MODULE_NOT_FOUND" },
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: {
          name: "Error",
          cause: { name: "AssertionError", code: "ERR_ASSERTION" },
        },
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: { name: "AssertionError", code: "ERR_ASSERTION_SUFFIX" },
      },
      {
        name: "Error",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: { name: "Error", code: "ERR_ASSERTION" },
      },
      {
        name: "TypeError",
        code: "ERR_TEST_FAILURE",
        failureType: "testCodeFailure",
        cause: { name: "AssertionError", code: "ERR_ASSERTION" },
      },
      { name: "AssertionError", code: "ERR_SYNTAX" },
      { name: "Error", code: "ERR_ASSERTION" },
    ]) {
      const original = attempts[0];
      assert.ok(original);
      const changed = structuredClone(original);
      const events = Buffer.from(changed.output.stdout.base64, "base64")
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failed = events.find((event) => event.type === "test:fail");
      assert.ok(failed);
      failed.data.details.error = error;
      changed.output = output(
        events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      assert.throws(
        () => inspectProjectNativeCheck(row, 0, row.project.checks[0], changed),
        /replaced by another runtime failure/,
      );
    }
  }
});
test("original Node assertion import and runtime failures retain distinct causes through the actual Checktrail reporter", async (t) => {
  const root = await fixture(t, {}),
    reporter = fileURLToPath(
      new URL("../src/node-reporter.js", import.meta.url),
    );
  for (const [name, body, accepted] of [
    ["assertion", "assert.equal(true,false)", true],
    [
      "runtime",
      "(()=>{throw new TypeError('synthetic runtime error')})()",
      false,
    ],
    ["loader", "await import('./missing-synthetic-module.mjs')", false],
  ] as const) {
    const filename = path.join(root, name + ".test.mjs");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      filename,
      "import{test}from'node:test';import assert from'node:assert/strict';test('original named boundary',async()=>{" +
        body +
        ";});test('original valid near miss',()=>assert.equal(true,true));",
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const actual = spawnSync(
      process.execPath,
      ["--test", "--test-reporter", reporter, filename],
      { env, encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
    );
    assert.equal(actual.error, undefined);
    assert.equal(actual.status, 1);
    assert.equal(actual.stderr, "");
    const events = actual.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failed = events.filter(
      (event) =>
        event.type === "test:fail" &&
        event.data.name === "original named boundary",
    );
    assert.equal(failed.length, 1);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "test:pass" &&
          event.data.name === "original valid near miss",
      ).length,
      1,
    );
    const error = failed[0].data.details.error;
    if (accepted) {
      assert.equal(error.code, "ERR_TEST_FAILURE");
      assert.equal(error.cause.code, "ERR_ASSERTION");
      requireProjectAssertionFailure(error);
    } else {
      assert.throws(
        () => requireProjectAssertionFailure(error),
        /replaced by another runtime failure/,
      );
      assert.notEqual(error.cause?.code, "ERR_ASSERTION");
    }
  }
});

test("shared project controller bindings project both families and their complete attempt records while global reconciliation retains unmatched failures", async () => {
  const { projectConsumerFamilyCollection } = await import(
    new URL(
      "../../scripts/consumer-witness-project-controller.mjs",
      import.meta.url,
    ).href
  );
  const { bindConsumerWitnessController } = await import(
    new URL("../../scripts/consumer-witness-evidence.mjs", import.meta.url).href
  );
  const { manifest, inventory, profiles } = await projectScope();
  const slot = inventory.runtimeProfiles.find(
    (value: { id: string }) => value.id === "native-linux-arm64-node22",
  );
  assert.ok(slot);
  const packets = (["javascript", "shared-json"] as const).flatMap((family) =>
    ["broken", "fixed", "near-miss"].flatMap((variant) =>
      ["source", "installed"].map((origin) =>
        envelope(family, variant, origin, slot, "workspace"),
      ),
    ),
  );
  const first = packets[0];
  assert.ok(first);
  const wanted = profiles["consumer-impact"];
  const events = wanted.map((item: { name: string }, i: number) => ({
    sequence: i + 1,
    fileId: "file-1",
    name: item.name,
    outcome: "passed",
    required: true,
    nameTruncated: false,
    kind: "test",
    durationMs: 1,
  }));
  const file = { state: "present", sha256: first.row.code.acceptanceSha256 };
  const collection = {
    profile: "native-consumer-witness-collection-v1",
    family: "javascript",
    observations: packets.map((packet) => packet.row),
    attemptRecords: packets.flatMap((packet) => packet.attempts),
    observedTool: first.row.tool,
    compiledEngine: {
      treeSha256: first.row.code.engineSha256,
      beforeAfterByteIdentitiesMatch: true,
    },
    evidence: {
      complete: true,
      required: 9,
      passed: 9,
      problems: [],
      ledger: {
        schemaVersion: 1,
        files: [{ id: "file-1", stable: true, before: file, after: file }],
        truncated: false,
        terminalEventCount: 9,
        events,
        cases: events.map((event: { name: string; sequence: number }) => ({
          fileId: "file-1",
          name: event.name,
          outcome: "passed",
          terminalSequences: [event.sequence],
        })),
      },
    },
  };
  const bind = (family: Family, current = collection) => {
    const subset = projectConsumerFamilyCollection(current, family);
    assert.equal(subset.family, family);
    assert.ok(
      subset.observations.every(
        (row: { family: string }) => row.family === family,
      ),
    );
    assert.ok(
      subset.attemptRecords.every(
        (row: { value: { family: string } }) => row.value.family === family,
      ),
    );
    return bindConsumerWitnessController(subset, {
      family,
      requirements: wanted,
      ...first.row.code,
      toolVersionMatched: true,
      selectedRuntimeSlot: slot.id,
      tool: collection.observedTool,
      toolInputsSha256: first.binding.toolInputsSha256,
      runtime: { ...first.row.runtime, hostAttestationPerformed: false },
      runtimeImage: first.binding.runtimeImage,
    });
  };
  const bindings = [...bind("javascript"), ...bind("shared-json")];
  assert.equal(bindings.length, collection.observations.length);
  assert.equal(
    collection.attemptRecords.length,
    packets.flatMap((packet) => packet.attempts).length,
  );
  const coverage = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    collection.observations,
    bindings,
    collection.attemptRecords,
  );
  assert.deepEqual(coverage.issues, []);
  const broken = structuredClone(collection),
    original = broken.attemptRecords[0];
  assert.ok(original);
  assert.equal(original.value.state, "failed");
  const extra = structuredClone(original);
  extra.value.attemptId = randomUUID();
  const bytes = JSON.stringify(extra.value) + "\n";
  extra.file = "attempt-" + extra.value.attemptId + ".json";
  extra.bytes = Buffer.byteLength(bytes);
  extra.sha256 = hash(bytes);
  broken.attemptRecords.push(extra);
  assert.throws(
    () => bind("javascript", broken),
    /Unmatched or failed consumer attempts/,
  );
  const report = inspectConsumerWitnesses(
    manifest,
    inventory,
    profiles,
    broken.observations,
    bindings,
    broken.attemptRecords,
  );
  assert.equal(
    report.issues.includes("failed-or-unavailable-consumer-attempt"),
    true,
  );
});

test("TypeScript project witnesses reconcile the exact locked tool versions and reject stale pins", async () => {
  const { selectJavaScriptToolsLock } = await import(
    new URL("../../scripts/prepare-javascript-tools.mjs", import.meta.url).href
  );
  const [manifest, lock] = await Promise.all(
    ["package.json", "package-lock.json"].map(async (file) =>
      JSON.parse(
        await readFile(new URL("../../" + file, import.meta.url), "utf8"),
      ),
    ),
  );
  const selected = selectJavaScriptToolsLock(manifest, lock);
  const versions = {
    eslint: selected.manifest.dependencies.eslint,
    vite: selected.manifest.dependencies.vite,
    rolldown: selected.lock.packages["node_modules/rolldown"].version,
    typescript: selected.manifest.dependencies.typescript,
  };
  const { row, attempts } = sample("typescript", "fixed", "library");
  const native = [
    null,
    ...attempts
      .slice(1)
      .map((attempt) =>
        JSON.parse(
          Buffer.from(attempt.output.stdout.base64, "base64").toString("utf8"),
        ),
      ),
  ];
  native[1].toolVersion = versions.eslint;
  native[2].versions = {
    vite: versions.vite,
    rolldown: versions.rolldown,
    typescript: versions.typescript,
  };
  attempts[1]!.output = output(JSON.stringify(native[1]));
  attempts[2]!.output = output(JSON.stringify(native[2]));
  inspectProjectWitness(row, attempts);
  for (const tool of ["eslint", "vite", "rolldown", "typescript"] as const) {
    const changed = structuredClone(attempts);
    const index = tool === "eslint" ? 1 : 2;
    const value = structuredClone(native[index]);
    if (tool === "eslint") value.toolVersion = "10.11.0";
    else value.versions[tool] = "0.0.0";
    changed[index]!.output = output(JSON.stringify(value));
    if (tool === "eslint") {
      assert.throws(() => inspectProjectWitness(row, changed), {
        name: "AssertionError",
        code: "ERR_ASSERTION",
      });
    } else {
      assert.throws(
        () => inspectProjectWitness(row, changed),
        (error: unknown) => {
          assert.ok(error instanceof ZodError);
          assert.deepEqual(
            error.issues.map(({ code, path }) => ({ code, path })),
            [{ code: "invalid_value", path: ["versions", tool] }],
          );
          return true;
        },
      );
    }
  }
  inspectProjectWitness(row, attempts);
});

test("native project witnesses reconcile check identities in every order while retaining actual report and attempt positions", () => {
  const permutations = (values: number[]): number[][] =>
    values.length === 0
      ? [[]]
      : values.flatMap((value, index) =>
          permutations(values.filter((_, position) => position !== index)).map(
            (rest) => [value, ...rest],
          ),
        );
  const bindPositions = (value: ReturnType<typeof sample>): void => {
    for (const [index, attempt] of value.attempts.entries()) {
      attempt.project.checkIndex = index;
      attempt.project.reportSha256 = hash(JSON.stringify(value.row.project));
    }
  };
  const reorder = (
    value: ReturnType<typeof sample>,
    order: number[],
  ): ReturnType<typeof sample> => {
    const result = {
      row: structuredClone(value.row),
      attempts: order.map((index) => structuredClone(value.attempts[index]!)),
    };
    result.row.project.checks = order.map((index) =>
      structuredClone(value.row.project.checks[index]!),
    );
    bindPositions(result);
    return result;
  };
  let inspected = 0;
  for (const family of ["javascript", "shared-json", "typescript"] as const)
    for (const variant of ["broken", "fixed", "near-miss"])
      for (const scenario of projectConsumerScenarios(family, variant)) {
        const original = sample(family, variant, scenario);
        for (const order of permutations(
          original.attempts.map((_, index) => index),
        )) {
          const value = reorder(original, order);
          inspectProjectWitness(value.row, value.attempts);
          inspected++;
        }
      }
  assert.equal(inspected, 132);
  const actualOrder = reorder(
    sample("typescript", "fixed", "library"),
    [0, 2, 1],
  );
  for (const defect of ["duplicate", "foreign"] as const) {
    const changed = structuredClone(actualOrder);
    if (defect === "duplicate") {
      changed.row.project.checks[2] = structuredClone(
        changed.row.project.checks[1]!,
      );
      changed.attempts[2] = structuredClone(changed.attempts[1]!);
      changed.attempts[2]!.attemptId = randomUUID();
    } else changed.row.project.checks[1]!.project = "foreign";
    bindPositions(changed);
    assert.throws(
      () => inspectProjectWitness(changed.row, changed.attempts),
      /check identities/,
    );
  }
  const wrongPosition = structuredClone(actualOrder);
  [wrongPosition.attempts[0], wrongPosition.attempts[1]] = [
    wrongPosition.attempts[1]!,
    wrongPosition.attempts[0]!,
  ];
  assert.throws(
    () => inspectProjectWitness(wrongPosition.row, wrongPosition.attempts),
    /another report\/scenario\/check/,
  );
  assert.throws(
    () =>
      inspectProjectNativeCheck(
        actualOrder.row,
        0,
        actualOrder.row.project.checks[1],
        actualOrder.attempts[0],
      ),
    /actual report position/,
  );
  inspectProjectWitness(actualOrder.row, actualOrder.attempts);
});
