import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const generatorGuardDefinitions = Object.freeze(
  [
    {
      id: "cancelled-retained-packet",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "false",
      from: "process.cancelled",
    },
    {
      id: "current-physical-input-bytes",
      name: "stale",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "mavenHash(b) === hash",
    },
    {
      id: "complete-current-dependency-tree",
      name: "stale",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "same(walk(repoRoot), repo.files.map((p) => p.path))",
    },
    {
      id: "raw-compiled-overload-signature",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "method.signature === c.methodSignature",
    },
    {
      id: "decoded-parameter-signatures",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "isDeepStrictEqual(method.parameterSignatures, c.parameterSignatures)",
    },
    {
      id: "decoded-return-signature",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "method.returnSignature === c.returnSignature",
    },
    {
      id: "current-native-helper-artifact",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "true",
      from: "n.helper.sha256 === identity.observerSha256",
    },
    {
      id: "physical-method-build-metadata-join",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      to: "need(true,",
      from: "need(sourceAgrees,",
    },
    {
      id: "complete-project-reference-graph",
      name: "empty",
      file: "dotnet-generator-extensions-evidence.js",
      pattern:
        "same\\(observedEdges, config\\.projectReferences\\.map\\(\\(r\\) => JSON\\.stringify\\(r\\)\\)\\)",
      to: "true",
    },
    {
      id: "native-method-token",
      name: "near-miss",
      file: "dotnet-generator-extensions-native.js",
      to: "methodToken=method.MetadataToken+1,",
      nativeSource: true,
      from: "methodToken=method.MetadataToken,",
    },
    {
      id: "native-inheritance-chain",
      name: "near-miss",
      file: "dotnet-generator-extensions-native.js",
      to: "type=null",
      nativeSource: true,
      from: "type=type.BaseType",
    },
    {
      id: "native-case-argument-retention",
      name: "near-miss",
      file: "dotnet-generator-extensions-native.js",
      to: "arguments=Array.Empty<object>()",
      nativeSource: true,
      from: "arguments=test.Arguments.Select(Argument).ToArray()",
    },
  ].map((row) => Object.freeze(row)),
);

export const dotnetGeneratorShardIds = Object.freeze(["0", "1", "2"]);
export const dotnetGeneratorControlIds = Object.freeze([
  "cancelled-retained-packet",
  "current-physical-input-bytes",
  "complete-current-dependency-tree",
  "raw-compiled-overload-signature",
  "decoded-parameter-signatures",
  "decoded-return-signature",
  "current-native-helper-artifact",
  "physical-method-build-metadata-join",
  "complete-project-reference-graph",
  "native-method-token",
  "native-inheritance-chain",
  "native-case-argument-retention",
]);
const nativeControls = [
  "native-method-token",
  "native-inheritance-chain",
  "native-case-argument-retention",
];
const baselineProfiles = [
  "dotnet-build",
  "dotnet-test",
  "dotnet-generated",
  "dotnet-method",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = (value, expected, message) => {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    message,
  );
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), message);
};
export const generatorCaseKey = (row) => JSON.stringify([row.file, row.name]);
function caseRows(rows, message) {
  assert.ok(
    Array.isArray(rows) && rows.length > 0 && rows.length <= 128,
    message,
  );
  for (const row of rows) {
    keys(row, ["file", "name"], message);
    assert.match(row.file, /^dist\/test\/[a-z0-9-]+\.test\.js$/u, message);
    assert.ok(
      typeof row.name === "string" &&
        row.name.length > 0 &&
        row.name.length <= 1024,
      message,
    );
  }
  assert.equal(new Set(rows.map(generatorCaseKey)).size, rows.length, message);
}
function exactUnion(actual, expected, message) {
  assert.equal(new Set(actual).size, actual.length, message + ": duplicate");
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}
export function validateGeneratorShardManifest(manifest, requirements) {
  keys(
    manifest,
    [
      "schemaVersion",
      "profile",
      "baselineProfiles",
      "sourceProfile",
      "installedOwner",
      "nativeCompileControlIds",
      "shards",
    ],
    "Invalid generator shard manifest fields",
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profile, "dotnet-generator-extensions");
  assert.equal(manifest.sourceProfile, manifest.profile);
  assert.deepEqual(manifest.baselineProfiles, baselineProfiles);
  assert.equal(manifest.installedOwner, "0");
  exactUnion(
    manifest.nativeCompileControlIds,
    nativeControls,
    "Native compile proof inventory changed",
  );
  assert.ok(Array.isArray(manifest.shards));
  exactUnion(
    manifest.shards.map((row) => row.id),
    dotnetGeneratorShardIds,
    "Incomplete generator shard inventory",
  );
  for (const profile of [...baselineProfiles, manifest.sourceProfile])
    caseRows(
      requirements[profile],
      "Missing or invalid required profile " + profile,
    );
  const expectedBaseline = baselineProfiles.flatMap(
    (profile) => requirements[profile],
  );
  caseRows(expectedBaseline, "Overlapping preserved baseline profiles");
  const allBaseline = [],
    allSource = [],
    allControls = [];
  for (const row of manifest.shards) {
    keys(
      row,
      ["id", "baseline", "source", "controls"],
      "Invalid generator shard fields",
    );
    caseRows(row.baseline, "Empty or invalid baseline partition");
    caseRows(row.source, "Empty or invalid source partition");
    assert.ok(Array.isArray(row.controls) && row.controls.length === 4);
    assert.equal(
      row.controls.filter((id) => nativeControls.includes(id)).length,
      1,
      "Every shard requires one native mutation compile proof",
    );
    allBaseline.push(...row.baseline.map(generatorCaseKey));
    allSource.push(...row.source.map(generatorCaseKey));
    allControls.push(...row.controls);
  }
  exactUnion(
    allBaseline,
    expectedBaseline.map(generatorCaseKey),
    "Preserved callback partition differs from required profiles",
  );
  exactUnion(
    allSource,
    requirements[manifest.sourceProfile].map(generatorCaseKey),
    "Source callback partition differs from required profile",
  );
  exactUnion(
    allControls,
    dotnetGeneratorControlIds,
    "Mutation control partition changed",
  );
  const installedName = "dotnet-generator-extensions installed acceptance";
  const owner = manifest.shards.find(
    (row) => row.id === manifest.installedOwner,
  );
  assert.ok(
    owner.source.some((row) => row.name === installedName),
    "Installed callback moved outside its sole owner",
  );
  assert.equal(
    allSource.filter((key) => JSON.parse(key)[1] === installedName).length,
    1,
  );
  return manifest;
}
export function selectGeneratorShard(manifest, id) {
  assert.ok(
    typeof id === "string" && dotnetGeneratorShardIds.includes(id),
    "Pass an exact generator shard ID: 0, 1 or 2",
  );
  return manifest.shards.find((row) => row.id === id);
}
export function parseGeneratorShardArguments(args) {
  assert.ok(
    Array.isArray(args) && args.length === 2 && args[0] === "--shard",
    "Use --shard 0, --shard 1 or --shard 2",
  );
  assert.ok(
    dotnetGeneratorShardIds.includes(args[1]),
    "Unknown generator shard argument",
  );
  return args[1];
}
export async function loadGeneratorShards(repository) {
  const manifestBytes = await readFile(
    path.join(repository, "scripts/dotnet-generator-shards.v1.json"),
  );
  const requirementsBytes = await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
  );
  const requirements = JSON.parse(requirementsBytes);
  const manifest = validateGeneratorShardManifest(
    JSON.parse(manifestBytes),
    requirements,
  );
  return {
    manifest,
    requirements,
    manifestSha256: hash(manifestBytes),
    requirementsSha256: hash(requirementsBytes),
  };
}
export function validateGeneratorJobContext(value) {
  keys(
    value,
    ["repository", "runId", "headSha", "checkoutSha", "jobId", "jobAttempt"],
    "Invalid generator GitHub job context",
  );
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  for (const field of ["runId", "jobId"])
    assert.ok(
      typeof value[field] === "string" && /^[1-9]\d{0,19}$/u.test(value[field]),
      "Invalid GitHub " + field,
    );
  assert.match(value.headSha, /^[a-f0-9]{40}$/u);
  assert.match(value.checkoutSha, /^[a-f0-9]{40}$/u);
  assert.ok(
    Number.isSafeInteger(value.jobAttempt) &&
      value.jobAttempt > 0 &&
      value.jobAttempt <= 10000,
    "Invalid actual job attempt",
  );
  return { ...value };
}
export function generatorJobContextFromEnvironment(env) {
  assert.ok(
    typeof env.CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT === "string",
    "Provide API-bound CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT before native execution",
  );
  const context = validateGeneratorJobContext(
    JSON.parse(env.CHECKTRAIL_DOTNET_GENERATOR_JOB_CONTEXT),
  );
  assert.equal(
    context.repository,
    env.GITHUB_REPOSITORY,
    "Job repository differs from workflow",
  );
  assert.equal(
    context.runId,
    env.GITHUB_RUN_ID,
    "Job run differs from workflow",
  );
  assert.equal(
    context.checkoutSha,
    env.GITHUB_SHA,
    "Checked-out source differs from workflow",
  );
  // The actual job attempt is retained verbatim. Rerunning another matrix row
  // does not relabel an earlier successful job as a new attempt.
  return context;
}
export function requireGeneratorRoleEvidence(report, rows) {
  caseRows(rows, "Invalid expected generator role cases");
  assert.equal(report.complete, true, "Incomplete generator role evidence");
  assert.equal(report.required, rows.length);
  assert.equal(report.passed, rows.length);
  assert.deepEqual(report.problems, []);
  assert.equal(report.ledger?.truncated, false);
  const files = report.ledger?.files;
  assert.ok(
    Array.isArray(files) &&
      files.length === new Set(rows.map((row) => row.file)).size,
    "Incomplete callback artifact inventory",
  );
  assert.equal(new Set(files.map((row) => row.id)).size, files.length);
  assert.ok(
    files.every(
      (row) =>
        row.stable === true &&
        row.before?.state === "present" &&
        row.after?.state === "present" &&
        /^[a-f0-9]{64}$/u.test(row.before.sha256) &&
        row.before.sha256 === row.after.sha256,
    ),
    "Callback source artifact changed",
  );
  assert.ok(
    report.compiledEngine?.beforeAfterByteIdentitiesMatch === true,
    "Missing stable compiled engine binding",
  );
  for (const field of [
    "treeSha256",
    "manifestSha256",
    "afterTreeSha256",
    "afterManifestSha256",
  ])
    assert.match(
      report.compiledEngine[field],
      /^[a-f0-9]{64}$/u,
      "Invalid compiled engine identity",
    );
  assert.equal(
    report.compiledEngine.treeSha256,
    report.compiledEngine.afterTreeSha256,
  );
  assert.equal(
    report.compiledEngine.manifestSha256,
    report.compiledEngine.afterManifestSha256,
  );
  assert.equal(
    report.ledger?.schemaVersion,
    1,
    "Unknown terminal ledger version",
  );
  const events = report.ledger?.events;
  assert.ok(
    Array.isArray(events) && events.length > 0,
    "Missing original terminal events",
  );
  assert.equal(report.ledger.terminalEventCount, events.length);
  assert.equal(
    new Set(events.map((row) => row.sequence)).size,
    events.length,
    "Duplicate terminal event sequence",
  );
  assert.ok(
    events.every(
      (row) => row.outcome === "passed" && row.nameTruncated === false,
    ),
    "Unsuccessful terminal event",
  );
  const cases = report.ledger?.cases;
  assert.ok(Array.isArray(cases) && cases.length === rows.length);
  // Names are unique within each reviewed role. File identities are retained
  // in the original terminal ledger rather than inferred from another shard.
  exactUnion(
    cases.map((row) => row.name),
    rows.map((row) => row.name),
    "Wrong generator role callback inventory",
  );
  assert.ok(
    cases.every((row) => files.some((file) => file.id === row.fileId)),
    "Callback has no retained file identity",
  );
  assert.ok(
    cases.every(
      (row) => row.outcome === "passed" && row.terminalSequences?.length === 1,
    ),
    "Skipped, failed, duplicate or incomplete generator callback",
  );
  for (const callback of cases) {
    const terminal = events.find(
      (event) => event.sequence === callback.terminalSequences[0],
    );
    assert.ok(
      terminal &&
        terminal.kind === "test" &&
        terminal.required === true &&
        terminal.name === callback.name &&
        terminal.fileId === callback.fileId &&
        terminal.outcome === callback.outcome,
      "Callback verdict differs from its original terminal event",
    );
  }
  return report;
}
const harnessFiles = [
  "scripts/dotnet-generator-shards.v1.json",
  "scripts/dotnet-generator-shards.mjs",
  "scripts/verify-dotnet-generator-shard-tests.mjs",
  "scripts/verify-dotnet-generator-extensions-container.mjs",
  "scripts/verify-dotnet-generator-extensions-guards.mjs",
  "scripts/required-native-tests.json",
  "scripts/fsharp-format-tools.Dockerfile",
  "dist/test/dotnet-generator-extensions-fixture.js",
  "dist/src/dotnet-generator-extensions-evidence.js",
  "dist/src/dotnet-generator-extensions-native.js",
];
export function generatorShardHarnessPaths(loaded) {
  return [
    ...new Set([
      ...harnessFiles,
      ...loaded.manifest.shards
        .flatMap((row) => [...row.baseline, ...row.source])
        .map((row) => row.file),
    ]),
  ].sort();
}
export async function captureGeneratorShardHarness(repository) {
  const files = [];
  for (const file of generatorShardHarnessPaths(
    await loadGeneratorShards(repository),
  )) {
    const bytes = await readFile(path.join(repository, file));
    assert.ok(
      bytes.length > 0 && bytes.length <= 4 * 1048576,
      "Invalid shard harness file bound",
    );
    files.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { files, sha256: hash(JSON.stringify(files)) };
}
export function requireStableGeneratorShardHarness(before, after) {
  assert.deepEqual(
    after,
    before,
    "Generator shard harness source changed during execution",
  );
  return { ...before, beforeAfterByteIdentitiesMatch: true };
}

export function createGeneratorShardFragment({
  loaded,
  shardId,
  context,
  runtime,
  baseline,
  source,
  installed,
  preparedCache,
  guards,
  mutationSources,
  harness,
  stageDurationMs,
  durationMs,
}) {
  validateGeneratorJobContext(context);
  validateGeneratorShardManifest(loaded.manifest, loaded.requirements);
  const shard = selectGeneratorShard(loaded.manifest, shardId);
  for (const [role, receipt] of [
    ["baseline", baseline],
    ["source", source],
  ]) {
    assert.equal(receipt.schemaVersion, 1, "Unknown role receipt version");
    assert.equal(
      receipt.scope,
      "dotnet-generator-required-role-fragment",
      "Wrong role receipt scope",
    );
    assert.equal(receipt.shard, shardId, "Wrong role shard");
    assert.equal(receipt.role, role, "Wrong evidence role");
    assert.deepEqual(receipt.context, context, "Wrong role job context");
    assert.equal(
      receipt.manifestSha256,
      loaded.manifestSha256,
      "Stale role manifest",
    );
    assert.equal(
      receipt.requirementsSha256,
      loaded.requirementsSha256,
      "Stale role requirements",
    );
    assert.equal(receipt.fragmentComplete, true);
    assert.equal(receipt.wholeProfileQualification, false);
    assert.deepEqual(
      receipt.requiredCaseKeys,
      shard[role].map(generatorCaseKey),
    );
    requireGeneratorRoleEvidence(receipt.evidence, shard[role]);
  }
  const engine = source.evidence.compiledEngine.treeSha256;
  assert.equal(
    baseline.evidence.compiledEngine.treeSha256,
    engine,
    "Baseline/source engine identity differs",
  );
  if (shardId === loaded.manifest.installedOwner) {
    assert.ok(installed, "Missing sole installed acceptance receipt");
    assert.equal(installed.offlineProductionInstall, true);
    assert.equal(installed.harnessOutsideInstalledPackage, true);
    requireGeneratorRoleEvidence(
      installed.profile,
      loaded.requirements[loaded.manifest.sourceProfile],
    );
    assert.equal(
      installed.profile.compiledEngine.treeSha256,
      engine,
      "Installed/source engine identity differs",
    );
  } else
    assert.equal(
      installed,
      null,
      "Installed acceptance belongs to exactly one shard",
    );
  assert.equal(guards.schemaVersion, 1);
  assert.equal(guards.profile, "dotnet-generator-extensions");
  assert.equal(guards.scope, "dotnet-generator-mutation-fragment");
  assert.equal(guards.shard, shardId);
  assert.deepEqual(guards.context, context, "Wrong mutation job context");
  assert.equal(
    guards.manifestSha256,
    loaded.manifestSha256,
    "Stale mutation manifest",
  );
  assert.equal(guards.requirementsSha256, loaded.requirementsSha256);
  assert.equal(guards.fragmentComplete, true);
  assert.equal(guards.wholeProfileQualification, false);
  assert.equal(guards.mutantAndRestoredProcessesPerControl, 2);
  for (const field of [
    "sourceRestored",
    "callbacksUnchanged",
    "fixturesUnchanged",
  ])
    assert.equal(guards[field], true, "Incomplete mutation source restoration");
  exactUnion(
    guards.expectedControlIds,
    shard.controls,
    "Mutation selection differs",
  );
  exactUnion(
    guards.controls.map((row) => row.id),
    shard.controls,
    "Mutation evidence inventory differs",
  );
  assert.ok(
    guards.controls.every(
      (row) =>
        row.originalPassed === true &&
        row.mutantCompiled === true &&
        row.mutantFailedAssertion === true &&
        row.restoredPassed === true &&
        row.expressionsReplaced === 1,
    ),
    "Incomplete mutation control",
  );
  const expectedNative = shard.controls.filter((id) =>
    loaded.manifest.nativeCompileControlIds.includes(id),
  );
  exactUnion(
    guards.nativeCompileProofIds,
    expectedNative,
    "Missing native mutation compile proof",
  );
  assert.ok(
    guards.controls
      .filter((row) => expectedNative.includes(row.id))
      .every((row) => row.mutatedNativeObserverCompiled === true),
  );
  keys(
    harness,
    ["files", "sha256", "beforeAfterByteIdentitiesMatch"],
    "Invalid shard harness binding",
  );
  assert.equal(
    harness.beforeAfterByteIdentitiesMatch,
    true,
    "Unstable shard harness",
  );
  assert.ok(Array.isArray(harness.files));
  assert.deepEqual(
    harness.files.map((row) => row.file),
    generatorShardHarnessPaths(loaded),
    "Missing or unknown shard harness source",
  );
  for (const row of harness.files) {
    keys(row, ["file", "bytes", "sha256"], "Invalid shard harness artifact");
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= 4 * 1048576,
    );
    assert.match(row.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(
    harness.sha256,
    hash(JSON.stringify(harness.files)),
    "Stale shard source digest",
  );
  const bindCallbacks = (report, rows) => {
    for (const callback of report.ledger.cases) {
      const expected = rows.find((row) => row.name === callback.name);
      const observed = report.ledger.files.find(
        (row) => row.id === callback.fileId,
      );
      const artifact = harness.files.find((row) => row.file === expected.file);
      assert.equal(
        observed.before.sha256,
        artifact.sha256,
        "Callback came from the wrong source artifact",
      );
    }
  };
  bindCallbacks(baseline.evidence, shard.baseline);
  bindCallbacks(source.evidence, shard.source);
  if (installed)
    bindCallbacks(
      installed.profile,
      loaded.requirements[loaded.manifest.sourceProfile],
    );
  const artifactSha = (file) =>
    harness.files.find((row) => row.file === file).sha256;
  assert.deepEqual(
    guards.callbacks,
    [
      {
        file: "gate-dotnet-generator-extensions.test.js",
        sha256: artifactSha(
          "dist/test/gate-dotnet-generator-extensions.test.js",
        ),
      },
    ],
    "Wrong mutation callback source",
  );
  assert.deepEqual(
    guards.fixtures,
    [
      {
        file: "dotnet-generator-extensions-fixture.js",
        sha256: artifactSha("dist/test/dotnet-generator-extensions-fixture.js"),
      },
    ],
    "Wrong mutation fixture source",
  );
  keys(
    mutationSources,
    [
      ...new Set(
        generatorGuardDefinitions.map((row) => "dist/src/" + row.file),
      ),
    ],
    "Missing or unknown original mutation sources",
  );
  for (const row of guards.controls) {
    const definition = generatorGuardDefinitions.find(
      (item) => item.id === row.id,
    );
    const file = "dist/src/" + definition.file;
    const expected = resolveGeneratorMutation(
      definition,
      mutationSources[file],
    ).binding;
    assert.equal(
      expected.originalSha256,
      artifactSha(file),
      "Original mutation bytes differ from captured harness",
    );
    for (const field of [
      "callback",
      "file",
      "nativeSource",
      "originalSha256",
      "mutantSha256",
    ])
      assert.equal(
        row[field],
        expected[field],
        "Mutation control ID is not bound to its prescribed experiment: " +
          row.id +
          " " +
          field,
      );
  }
  assert.ok(
    typeof runtime.image?.selectedReference === "string" &&
      runtime.image.selectedReference.length > 0,
  );
  assert.match(runtime.image.observedImageId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(runtime.node.version, "v22.23.2");
  assert.equal(runtime.node.platform, "linux");
  assert.equal(runtime.node.arch, "arm64");
  assert.match(runtime.node.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(runtime.sdk.version, "10.0.401");
  assert.equal(runtime.sdk.runtime, "10.0.12");
  assert.equal(runtime.sdk.byteVerified, true);
  assert.match(runtime.sdk.pinsSha256, /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 0);
  return {
    schemaVersion: 1,
    profile: loaded.manifest.profile,
    scope: "selected-dotnet-generator-fragment",
    shard: {
      id: shardId,
      count: 3,
      installedOwner: loaded.manifest.installedOwner,
    },
    context,
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    runtime,
    harness,
    baseline,
    source,
    installed,
    preparedCache,
    guards,
    environment: {
      network: "none",
      readOnlyRoot: true,
      user: "1000:1000",
      cpuLimit: 2,
      memoryBytes: 4 * 1024 ** 3,
      pidLimit: 256,
      tmpfsBytes: 2 * 1024 ** 3,
    },
    concurrency: {
      maxNativeContainersPerFragment: 2,
      aggregateCpuLimitPerFragment: 4,
      aggregateMemoryBytesPerFragment: 8 * 1024 ** 3,
      completeThreeShardEnvelope: {
        maxNativeContainers: 6,
        aggregateCpuLimit: 12,
        aggregateMemoryBytes: 24 * 1024 ** 3,
      },
      sharedWritableFixtures: false,
    },
    selectedRoles: {
      baseline: shard.baseline,
      source: shard.source,
      installed: installed
        ? loaded.requirements[loaded.manifest.sourceProfile]
        : [],
      mutationControlIds: shard.controls,
    },
    stageDurationMs,
    durationMs,
    fragmentComplete: true,
    wholeProfileQualification: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    wholeRuntimeClosureVerified: false,
    platformMatrixComplete: false,
    gateAComplete: false,
  };
}

export function resolveGeneratorMutation(control, original) {
  const expected = generatorGuardDefinitions.find(
    (row) => row.id === control.id,
  );
  assert.ok(expected, "Unknown generator mutation ID");
  assert.deepEqual(
    control,
    expected,
    "Mutation definition differs from canonical experiment",
  );
  assert.ok(
    typeof original === "string" &&
      original.length > 0 &&
      original.length <= 4 * 1048576,
    "Invalid original mutation source",
  );
  let from = expected.from;
  if (expected.pattern) {
    const matches = [...original.matchAll(new RegExp(expected.pattern, "g"))];
    assert.equal(
      matches.length,
      1,
      "Mutation pattern must match exactly once: " + expected.id,
    );
    from = matches[0][0];
  }
  assert.ok(typeof from === "string" && from.length > 0);
  assert.equal(
    original.split(from).length,
    2,
    "Mutation must replace exactly one original expression: " + expected.id,
  );
  const source = original.replace(from, expected.to);
  const binding = {
    id: expected.id,
    callback: "dotnet-generator-extensions " + expected.name + " acceptance",
    file: "dist/src/" + expected.file,
    nativeSource: expected.nativeSource === true,
    originalSha256: hash(original),
    mutantSha256: hash(source),
  };
  assert.notEqual(binding.originalSha256, binding.mutantSha256);
  return { source, binding };
}
export async function captureGeneratorMutationSources(repository) {
  const sources = {};
  for (const file of [
    ...new Set(generatorGuardDefinitions.map((row) => "dist/src/" + row.file)),
  ]) {
    const bytes = await readFile(path.join(repository, file));
    const source = bytes.toString("utf8");
    assert.equal(
      hash(source),
      hash(bytes),
      "Mutation source must retain its exact UTF-8 bytes",
    );
    sources[file] = source;
  }
  return sources;
}

/** Revalidate a transported fragment against independently captured current bytes. */
export function validateGeneratorShardFragment(
  fragment,
  { loaded, context, harness, mutationSources },
) {
  validateGeneratorJobContext(context);
  assert.deepEqual(
    fragment.context,
    context,
    "Fragment belongs to another producer execution",
  );
  assert.deepEqual(
    fragment.harness,
    { ...harness, beforeAfterByteIdentitiesMatch: true },
    "Fragment belongs to another current harness",
  );
  const expected = createGeneratorShardFragment({
    loaded,
    shardId: fragment.shard?.id,
    context,
    runtime: fragment.runtime,
    baseline: fragment.baseline,
    source: fragment.source,
    installed: fragment.installed,
    preparedCache: fragment.preparedCache,
    guards: fragment.guards,
    mutationSources,
    harness: fragment.harness,
    stageDurationMs: fragment.stageDurationMs,
    durationMs: fragment.durationMs,
  });
  assert.deepEqual(
    fragment,
    expected,
    "Foreign or noncanonical generator fragment fields",
  );
  return fragment;
}

/** This proves the complete evidence union; hosted job/artifact admission is still separate. */
export function aggregateGeneratorShardFragments({
  loaded,
  fragments,
  contexts,
  harness,
  mutationSources,
}) {
  validateGeneratorShardManifest(loaded.manifest, loaded.requirements);
  keys(
    contexts,
    dotnetGeneratorShardIds,
    "Missing or foreign generator producer contexts",
  );
  assert.ok(Array.isArray(fragments));
  exactUnion(
    fragments.map((row) => row.shard?.id),
    dotnetGeneratorShardIds,
    "Missing duplicate or foreign generator fragment",
  );
  for (const fragment of fragments)
    validateGeneratorShardFragment(fragment, {
      loaded,
      context: contexts[fragment.shard.id],
      harness,
      mutationSources,
    });
  const ordered = dotnetGeneratorShardIds.map((id) =>
    fragments.find((row) => row.shard.id === id),
  );
  exactUnion(
    ordered.flatMap((row) => row.selectedRoles.baseline.map(generatorCaseKey)),
    loaded.manifest.baselineProfiles
      .flatMap((profile) => loaded.requirements[profile])
      .map(generatorCaseKey),
    "Preserved baseline union differs",
  );
  exactUnion(
    ordered.flatMap((row) => row.selectedRoles.source.map(generatorCaseKey)),
    loaded.requirements[loaded.manifest.sourceProfile].map(generatorCaseKey),
    "Source callback union differs",
  );
  exactUnion(
    ordered.flatMap((row) => row.selectedRoles.mutationControlIds),
    dotnetGeneratorControlIds,
    "Mutation control union differs",
  );
  exactUnion(
    ordered.flatMap((row) => row.guards.nativeCompileProofIds),
    loaded.manifest.nativeCompileControlIds,
    "Native compile proof union differs",
  );
  assert.deepEqual(
    ordered.filter((row) => row.installed !== null).map((row) => row.shard.id),
    [loaded.manifest.installedOwner],
    "Installed child acceptance must have exactly one owner",
  );
  const engines = ordered.map((row) => row.source.evidence.compiledEngine);
  assert.ok(
    engines.every(
      (row) =>
        row.treeSha256 === engines[0].treeSha256 &&
        row.manifestSha256 === engines[0].manifestSha256,
    ),
    "Shard compiled engines differ",
  );
  return {
    schemaVersion: 1,
    profile: loaded.manifest.profile,
    scope: "complete-dotnet-generator-evidence-union",
    manifestSha256: loaded.manifestSha256,
    requirementsSha256: loaded.requirementsSha256,
    shards: ordered.map((row) => ({ id: row.shard.id, context: row.context })),
    baselineCaseKeys: ordered.flatMap((row) =>
      row.selectedRoles.baseline.map(generatorCaseKey),
    ),
    sourceCaseKeys: ordered.flatMap((row) =>
      row.selectedRoles.source.map(generatorCaseKey),
    ),
    installedCaseKeys:
      loaded.requirements[loaded.manifest.sourceProfile].map(generatorCaseKey),
    mutationControlIds: [...dotnetGeneratorControlIds],
    nativeCompileProofIds: [...loaded.manifest.nativeCompileControlIds],
    cohortEvidenceComplete: true,
    wholeProfileQualification: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}
