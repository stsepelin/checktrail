import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
const { consumerNativeAcceptanceScopes } = await import(
  new URL("../../scripts/consumer-native-acceptance-scope.mjs", import.meta.url)
    .href
);
const {
  consumerNativeScopeSummary,
  validateConsumerNativeCapsule,
  aggregateConsumerNativeCapsules,
  consumerNativeScopeJob,
  requireConsumerNativeCaseLedger,
} = await import(
  new URL(
    "../../scripts/consumer-native-acceptance-capsule.mjs",
    import.meta.url,
  ).href
);
const manifest = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-consumer-witnesses.v1.json", import.meta.url),
      "utf8",
    ),
  ),
  inventory = JSON.parse(
    await readFile(
      new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  ),
  profiles = JSON.parse(
    await readFile(
      new URL("../../scripts/required-native-tests.json", import.meta.url),
      "utf8",
    ),
  ),
  scopes = consumerNativeAcceptanceScopes(manifest, inventory, profiles),
  hash = (value: string) => createHash("sha256").update(value).digest("hex");
function frame() {
  return {
    schemaVersion: 1,
    profile: "native-consumer-current-source-frame-v1",
    commit: "a".repeat(40),
    gitTree: "b".repeat(40),
    sourceManifestSha256: "1".repeat(64),
    engineSha256: "2".repeat(64),
    engineManifestSha256: "3".repeat(64),
    harnessSha256: "9".repeat(64),
    harnessManifestSha256: "a".repeat(64),
    inventorySha256: "4".repeat(64),
    inventoryScopeSha256: "5".repeat(64),
    requirementsSha256: "6".repeat(64),
    packageManifestSha256: "7".repeat(64),
    packageLockSha256: "8".repeat(64),
    sourceFiles: 1,
    sourceBytes: 1,
    clean: true,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
const ci = {
  kind: "github-actions-run-metadata",
  runId: "1234",
  runAttempt: "2",
  job: "ci-complete",
  metadataAttested: false,
};
// Synthetic transport/schema fixtures, never replacements for executed native acceptance.
function capsule(scope: (typeof scopes)[number]) {
  const witnesses = Object.values(scope.requiredObservations)
    .flat()
    .map((key) => ({ key, witnessId: randomUUID(), sha256: "a".repeat(64) }));
  const body = {
    schemaVersion: 1,
    profile: "native-consumer-scope-capsule-v1",
    scope: consumerNativeScopeSummary(scope),
    source: frame(),
    attemptId: randomUUID(),
    ci: { ...ci, job: consumerNativeScopeJob(scope) },
    controller: {
      moduleCompleted: true,
      processExitObserved: false,
      stdoutSha256: "b".repeat(64),
      stdoutBytes: 1,
      stderrSha256: "c".repeat(64),
      stderrBytes: 0,
      requiresSuccessfulOuterJob: true,
    },
    witnesses,
    observationCount: witnesses.length,
    attemptRecords: 1,
    attemptIds: [randomUUID()],
    journalManifestSha256: "d".repeat(64),
    registrySha256s: [hash(randomUUID())],
    semanticEvidenceSha256: "f".repeat(64),
    scopeComplete: true,
    arbitraryApplicationSemanticsVerified: false,
    currentNativeMatrixComplete: false,
    wholeUpstreamClosureVerified: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  return { ...body, capsuleSha256: hash(JSON.stringify(body)) };
}
function sign<T extends { capsuleSha256: string }>(value: T) {
  const { capsuleSha256, ...body } = value;
  assert.equal(typeof capsuleSha256, "string");
  return { ...body, capsuleSha256: hash(JSON.stringify(body)) };
}
function inputs() {
  return {
    manifest,
    inventory,
    profiles,
    source: frame(),
    capsules: scopes.map(capsule),
    selectedJobs: Object.fromEntries(
      scopes.map((scope: (typeof scopes)[number]) => [
        consumerNativeScopeJob(scope),
        true,
      ]),
    ),
    completedJobs: Object.fromEntries(
      scopes.map((scope: (typeof scopes)[number]) => [
        consumerNativeScopeJob(scope),
        { result: "success" },
      ]),
    ),
    ci,
  };
}
test("synthetic native capsule transport requires every declared family runtime scenario and completed outer job before matrix closure while retaining other Gate A obligations", () => {
  assert.equal(scopes.length, 26);
  const selected = inputs(),
    report = aggregateConsumerNativeCapsules(selected);
  assert.equal(report.consumerProfileComplete, true);
  assert.equal(report.allDeclaredScopesComplete, true);
  assert.equal(report.selectedScopes.length, scopes.length);
  assert.deepEqual(report.unselectedScopes, []);
  assert.equal(report.wholeUpstreamClosureVerified, false);
  assert.equal(report.gateAComplete, false);
  const php = scopes.find(
      (scope: (typeof scopes)[number]) =>
        scope.acceptanceProfile === "context-php",
    )!,
    partial = aggregateConsumerNativeCapsules({
      ...selected,
      capsules: [capsule(php)],
      selectedJobs: { [consumerNativeScopeJob(php)]: true },
    });
  assert.equal(partial.consumerProfileComplete, false);
  assert.equal(partial.unselectedScopes.length, scopes.length - 1);
  const empty = aggregateConsumerNativeCapsules({
    ...selected,
    capsules: [],
    selectedJobs: {},
  });
  assert.equal(empty.consumerProfileComplete, false);
  assert.equal(empty.unselectedScopes.length, scopes.length);
});
test("native capsule aggregation refuses missing duplicate stale failed skipped foreign or reused scopes even when every summary claims complete", () => {
  const selected = inputs();
  assert.throws(
    () =>
      aggregateConsumerNativeCapsules({
        ...selected,
        capsules: selected.capsules.slice(1),
      }),
    /remain missing/,
  );
  assert.throws(
    () =>
      aggregateConsumerNativeCapsules({
        ...selected,
        capsules: [selected.capsules[0], ...selected.capsules.slice(0, -1)],
      }),
    /Duplicate native matrix scope/,
  );
  const reused = structuredClone(selected);
  reused.capsules[1]!.attemptId = reused.capsules[0]!.attemptId;
  reused.capsules[1] = sign(reused.capsules[1]!);
  assert.throws(
    () => aggregateConsumerNativeCapsules(reused),
    /Reused native matrix attempt/,
  );
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    const changed = structuredClone(selected);
    changed.completedJobs[consumerNativeScopeJob(scopes[0])] = { result };
    assert.throws(() => aggregateConsumerNativeCapsules(changed), /outer job/);
  }
  for (const field of ["runId", "runAttempt", "job"] as const) {
    const changed = structuredClone(selected);
    changed.capsules[0]!.ci[field] = field === "job" ? "foreign-job" : "999";
    changed.capsules[0] = sign(changed.capsules[0]!);
    assert.throws(() => aggregateConsumerNativeCapsules(changed));
  }
  const stale = structuredClone(selected);
  stale.capsules[0]!.source.packageLockSha256 = "e".repeat(64);
  stale.capsules[0] = sign(stale.capsules[0]!);
  assert.throws(() => aggregateConsumerNativeCapsules(stale), /another source/);
  assert.throws(
    () =>
      aggregateConsumerNativeCapsules({
        ...selected,
        ci: {
          kind: "local-operator-metadata",
          runId: null,
          runAttempt: null,
          job: null,
          metadataAttested: false,
        },
      }),
    /actual workflow/,
  );
});
test("native capsule schema rejects coherent scenario omissions forged promotion flags private job attestation and altered digest bytes", () => {
  const scope = scopes[0],
    original = capsule(scope);
  validateConsumerNativeCapsule(original, scope, frame());
  const missing = structuredClone(original);
  missing.witnesses.pop();
  assert.throws(() =>
    validateConsumerNativeCapsule(sign(missing), scope, frame()),
  );
  const duplicate = structuredClone(original);
  duplicate.witnesses[1] = duplicate.witnesses[0]!;
  assert.throws(() =>
    validateConsumerNativeCapsule(sign(duplicate), scope, frame()),
  );
  const corrupt = structuredClone(original);
  corrupt.controller.stdoutBytes++;
  assert.throws(
    () => validateConsumerNativeCapsule(corrupt, scope, frame()),
    /altered/,
  );
  for (const field of [
    "gateAComplete",
    "wholeUpstreamClosureVerified",
    "hostAttestationPerformed",
    "currentNativeMatrixComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ] as const) {
    const changed = { ...original, [field]: true };
    assert.throws(() =>
      validateConsumerNativeCapsule(sign(changed), scope, frame()),
    );
  }
  const attested = structuredClone(original);
  attested.ci.metadataAttested = true;
  assert.throws(() =>
    validateConsumerNativeCapsule(sign(attested), scope, frame()),
  );
});
test("native terminal ledger binds all original files exact callback sequences and current bytes rather than trusting green totals", () => {
  const requirements = Array.from({ length: 10 }, (_, index) => ({
      file: index < 8 ? "main.js" : index === 8 ? "privacy.js" : "lifecycle.js",
      name: "original-synthetic-case-" + index,
    })),
    files = [...new Set(requirements.map((row) => row.file))],
    fileHashes = Object.fromEntries(
      files.map((file, index) => [file, String(index + 1).repeat(64)]),
    ),
    ids = new Map(files.map((file, index) => [file, "file-" + (index + 1)])),
    events = requirements.map((row, index) => ({
      sequence: index + 1,
      fileId: ids.get(row.file),
      name: row.name,
      nameTruncated: false,
      kind: "test",
      outcome: "passed",
      durationMs: 1,
      required: true,
    })),
    evidence = {
      complete: true,
      required: requirements.length,
      passed: requirements.length,
      problems: [],
      ledger: {
        schemaVersion: 1,
        truncated: false,
        terminalEventCount: requirements.length,
        files: files.map((file) => ({
          id: ids.get(file),
          stable: true,
          before: { state: "present", sha256: fileHashes[file] },
          after: { state: "present", sha256: fileHashes[file] },
        })),
        events,
        cases: events.map((event) => ({
          fileId: event.fileId,
          name: event.name,
          outcome: event.outcome,
          terminalSequences: [event.sequence],
        })),
      },
    };
  requireConsumerNativeCaseLedger(evidence, requirements, fileHashes);
  for (const edit of [
    "missing",
    "skipped",
    "stale",
    "sequence",
    "duplicate",
    "unbound",
  ]) {
    const changed = structuredClone(evidence);
    if (edit === "missing") changed.ledger.events.pop();
    if (edit === "skipped") changed.ledger.events[0]!.outcome = "skipped";
    if (edit === "stale")
      changed.ledger.files[2]!.after.sha256 = "f".repeat(64);
    if (edit === "sequence") changed.ledger.cases[0]!.terminalSequences = [2];
    if (edit === "duplicate") changed.ledger.events[1]!.sequence = 1;
    if (edit === "unbound") changed.ledger.cases[0]!.fileId = "file-3";
    assert.throws(() =>
      requireConsumerNativeCaseLedger(changed, requirements, fileHashes),
    );
  }
});

test("native matrix rejects cross-scope reuse of original witness process and registry identities even with coherent capsule digests", () => {
  const selected = inputs();
  for (const kind of ["witness", "process", "registry"]) {
    const changed = structuredClone(selected),
      first = changed.capsules[0]!,
      second = changed.capsules[1]!;
    if (kind === "witness")
      second.witnesses[0]!.witnessId = first.witnesses[0]!.witnessId;
    else if (kind === "process") second.attemptIds[0] = first.attemptIds[0]!;
    else second.registrySha256s[0] = first.registrySha256s[0]!;
    changed.capsules[1] = sign(second);
    assert.throws(
      () => aggregateConsumerNativeCapsules(changed),
      /Reused native/,
    );
  }
  assert.equal(
    aggregateConsumerNativeCapsules(selected).consumerProfileComplete,
    true,
  );
});
