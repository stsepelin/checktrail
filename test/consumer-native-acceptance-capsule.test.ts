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
  selectConsumerNativeProducerClaims,
  consumerNativeScopeLane,
} = await import(
  new URL(
    "../../scripts/consumer-native-acceptance-capsule.mjs",
    import.meta.url,
  ).href
);
const {
  createConsumerNativeJobStart,
  createConsumerNativeJobFinish,
  consumerNativeArtifactName,
  consumerNativeJobOutputKeys,
} = await import(
  new URL("../../scripts/consumer-native-job-claims.mjs", import.meta.url).href
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
function producerOutputs(capsules: ReturnType<typeof capsule>[]) {
  const groups = new Map<string, ReturnType<typeof capsule>[]>();
  for (const row of capsules) {
    const scope = scopes.find(
        (scope: (typeof scopes)[number]) => scope.id === row.scope.id,
      )!,
      job = consumerNativeScopeJob(scope),
      lane = consumerNativeScopeLane(scope),
      key = job + ":" + lane;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const completed: Record<
    string,
    { result: string | undefined; outputs: Record<string, string> }
  > = {};
  let artifact = 100;
  for (const [key, rows] of groups) {
    const parts = key.split(":");
    assert.equal(parts.length, 2);
    const job = parts[0]!,
      lane = parts[1]!,
      start = createConsumerNativeJobStart(
        {
          GITHUB_ACTIONS: "true",
          GITHUB_RUN_ID: ci.runId,
          GITHUB_RUN_ATTEMPT: rows[0]!.ci.runAttempt,
          GITHUB_SHA: frame().commit,
          GITHUB_JOB: job,
        },
        lane,
      ),
      finish = createConsumerNativeJobFinish(start, frame(), rows, {
        id: String(++artifact),
        name: consumerNativeArtifactName(job, lane, start.runAttempt),
        digest: hash(key + artifact),
      }),
      names = consumerNativeJobOutputKeys(job, lane);
    completed[job] ??= { result: "success", outputs: {} };
    completed[job]!.outputs[names.start] = JSON.stringify(start);
    completed[job]!.outputs[names.finish] = JSON.stringify(finish);
  }
  return completed;
}
function inputs() {
  const capsules: ReturnType<typeof capsule>[] = scopes.map(capsule);
  return {
    manifest,
    inventory,
    profiles,
    source: frame(),
    capsules,
    selectedJobs: Object.fromEntries(
      scopes.map((scope: (typeof scopes)[number]) => [
        consumerNativeScopeJob(scope),
        true,
      ]),
    ),
    completedJobs: producerOutputs(capsules),
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
      capsules: selected.capsules.filter((row) => row.scope.id === php.id),
      selectedJobs: { [consumerNativeScopeJob(php)]: true },
    });
  assert.throws(
    () =>
      aggregateConsumerNativeCapsules({
        ...selected,
        capsules: [capsule(php)],
        selectedJobs: { [consumerNativeScopeJob(php)]: true },
      }),
    /selected immutable artifact claim/,
  );
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
    changed.completedJobs[consumerNativeScopeJob(scopes[0])] = {
      ...changed.completedJobs[consumerNativeScopeJob(scopes[0])]!,
      result,
    };
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

test("native matrix accepts exact same-run retained successful producer outputs alongside newer attempts including independent retained matrix lanes", () => {
  const selected = inputs();
  for (const row of selected.capsules) {
    if (
      row.scope.acceptanceProfile !== "context-rust" &&
      row.scope.slot !== "ci-linux-node24"
    ) {
      row.ci.runAttempt = "1";
    }
    Object.assign(row, sign(row));
  }
  selected.completedJobs = producerOutputs(selected.capsules);
  const report = aggregateConsumerNativeCapsules(selected);
  assert.equal(report.consumerProfileComplete, true);
  assert.ok(
    report.producerArtifacts.some(
      (row: { producerAttempt: string }) => row.producerAttempt === "1",
    ),
  );
  assert.ok(
    report.producerArtifacts.some(
      (row: { producerAttempt: string }) => row.producerAttempt === "2",
    ),
  );
  const php = scopes.find(
      (scope: (typeof scopes)[number]) =>
        scope.acceptanceProfile === "context-php",
    )!,
    rust = scopes.find(
      (scope: (typeof scopes)[number]) =>
        scope.acceptanceProfile === "context-rust",
    )!,
    partial = {
      ...selected,
      capsules: selected.capsules.filter((row) =>
        [php.id, rust.id].includes(row.scope.id),
      ),
      selectedJobs: {
        [consumerNativeScopeJob(php)]: true,
        [consumerNativeScopeJob(rust)]: true,
      },
    };
  assert.equal(
    aggregateConsumerNativeCapsules(partial).selectedScopes.length,
    2,
  );
});

test("native producer claims reject missing or mismatched latest starts finishes foreign future failed skipped and reused immutable artifacts without falling back", () => {
  const selected = inputs(),
    php = scopes.find(
      (scope: (typeof scopes)[number]) =>
        scope.acceptanceProfile === "context-php",
    )!,
    job = consumerNativeScopeJob(php),
    names = consumerNativeJobOutputKeys(job, "single"),
    check = (changed: ReturnType<typeof inputs>) =>
      selectConsumerNativeProducerClaims({
        scopes,
        selectedJobs: changed.selectedJobs,
        completedJobs: changed.completedJobs,
        source: changed.source,
        ci: changed.ci,
      });
  for (const kind of [
    "missing-start",
    "missing-finish",
    "new-start-old-finish",
    "changed-nonce",
    "altered-finish-producer",
    "changed-start-digest",
    "foreign-artifact-name",
    "missing-artifact-digest",
    "foreign-run",
    "future",
    "foreign-source",
    "failed",
    "skipped",
    "duplicate-artifact",
    "missing-capsule-hash",
  ]) {
    const changed = structuredClone(selected),
      outputs = changed.completedJobs[job]!.outputs,
      start = JSON.parse(outputs[names.start]!),
      finish = JSON.parse(outputs[names.finish]!);
    if (kind === "missing-start") delete outputs[names.start];
    else if (kind === "missing-finish") delete outputs[names.finish];
    else if (kind === "new-start-old-finish") {
      start.runAttempt = "3";
      changed.ci.runAttempt = "3";
      outputs[names.start] = JSON.stringify(start);
    } else if (kind === "changed-nonce") {
      start.nonce = randomUUID();
      outputs[names.start] = JSON.stringify(start);
    } else if (kind === "altered-finish-producer") {
      finish.producer.nonce = randomUUID();
      outputs[names.finish] = JSON.stringify(finish);
    } else if (kind === "changed-start-digest") {
      finish.startSha256 = "0".repeat(64);
      outputs[names.finish] = JSON.stringify(finish);
    } else if (kind === "foreign-artifact-name") {
      finish.artifact.name = "native-consumer-rust-context-arm64-single-2";
      outputs[names.finish] = JSON.stringify(finish);
    } else if (kind === "missing-artifact-digest") {
      finish.artifact.digest = "";
      outputs[names.finish] = JSON.stringify(finish);
    } else if (kind === "foreign-run") {
      start.runId = "999";
      outputs[names.start] = JSON.stringify(start);
    } else if (kind === "future") {
      start.runAttempt = "3";
      outputs[names.start] = JSON.stringify(start);
    } else if (kind === "foreign-source") {
      finish.sourceFrameSha256 = "0".repeat(64);
      outputs[names.finish] = JSON.stringify(finish);
    } else if (kind === "failed" || kind === "skipped")
      changed.completedJobs[job]!.result =
        kind === "failed" ? "failure" : "skipped";
    else if (kind === "missing-capsule-hash") {
      finish.capsules = [];
      outputs[names.finish] = JSON.stringify(finish);
    } else {
      const other = Object.values(changed.completedJobs).find(
          (row) => row !== changed.completedJobs[job]!,
        )!,
        key = Object.keys(other.outputs).find((key) =>
          key.startsWith("native_finish_"),
        )!,
        prior = JSON.parse(other.outputs[key]!);
      finish.artifact.id = prior.artifact.id;
      outputs[names.finish] = JSON.stringify(finish);
    }
    assert.throws(() => check(changed), kind);
  }
  const future = inputs();
  for (const row of future.capsules) {
    row.ci.runAttempt = "3";
    Object.assign(row, sign(row));
  }
  future.completedJobs = producerOutputs(future.capsules);
  assert.throws(() => check(future), /future/);
  const altered = structuredClone(selected);
  altered.capsules[0]!.controller.stdoutBytes++;
  altered.capsules[0] = sign(altered.capsules[0]!);
  assert.throws(
    () => aggregateConsumerNativeCapsules(altered),
    /selected immutable artifact claim/,
  );
  assert.equal(check(selected).length, 25);
});
