import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
            details: { error: failed ? { code: "ERR_ASSERTION" } : null },
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
        toolVersion: "10.11.0",
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
