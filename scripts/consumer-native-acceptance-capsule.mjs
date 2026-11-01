import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  selectConsumerNativeAcceptance,
  consumerNativeAcceptanceScopes,
} from "./consumer-native-acceptance-scope.mjs";
import {
  requireConsumerNativeSourceFrame,
  validateConsumerNativeSourceFrame,
} from "./consumer-native-acceptance-frame.mjs";
import { captureConsumerWitnessCode } from "./consumer-witness-controller.mjs";
import {
  inspectConsumerWitnesses,
  requireQualifiedConsumerWitnessFamily,
  requireQualifiedConsumerWitnessSlot,
} from "./consumer-witness-evidence.mjs";
import {
  captureSelectedClangConsumerCode,
  inspectSelectedClangConsumerWitnesses,
  requireSelectedClangConsumerWitnesses,
} from "./selected-clang-consumer-witness.mjs";
import {
  reconcileConsumerNativeJournals,
  requireConsumerNativeJournalCollection,
} from "./consumer-native-acceptance-journals.mjs";
import {
  consumerNativeJobLanes,
  consumerNativeJobOutputKeys,
  requireConsumerNativeProducerClaims,
} from "./consumer-native-job-claims.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const project = new Set(["javascript", "typescript", "shared-json"]);
const parse = (bytes) =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
export const consumerNativeScopeSummary = (scope) => ({
  id: scope.id,
  acceptanceProfile: scope.acceptanceProfile,
  slot: scope.runtime.id,
  families: scope.families,
  selectedClang: scope.selectedClang,
  commandArguments: scope.command.args,
  requirementsSha256: hash(JSON.stringify(scope.requiredObservations)),
});
export const consumerNativeCapsuleFilename = (scope) => {
  assert.match(scope.id, /^[a-z][a-z-]*:[a-z0-9-]+$/);
  return scope.id.replace(":", "--") + ".json";
};
function address(scope, row) {
  if (scope.selectedClang)
    return {
      variant: row.variant,
      origin: row.origin,
      phase: row.phase,
      scenario: row.scenario,
    };
  return {
    family: row.family,
    variant: row.variant,
    origin: row.origin,
    slot: scope.runtime.id,
    ...(project.has(row.family) ? { scenario: row.project.scenario } : {}),
  };
}
function requireEntry(entry, bytes, stderr) {
  assert.equal(entry.profile, "captured-operator-controller-entrypoint-v1");
  assert.equal(
    entry.complete,
    true,
    "Original native controller did not complete",
  );
  assert.equal(entry.moduleCompleted, true);
  assert.equal(entry.exitRequested, null);
  assert.equal(entry.exitCodeRequested, 0);
  assert.equal(entry.error, null);
  assert.equal(entry.captureError, null);
  assert.equal(entry.truncated, false);
  assert.equal(entry.processExitObserved, false);
  assert.equal(entry.nativeProcessStartAcknowledgementRetained, false);
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1048576,
  );
  assert.equal(bytes.length, entry.stdout.bytes);
  assert.equal(entry.stdout.observedBytes, entry.stdout.bytes);
  assert.equal(hash(bytes), entry.stdout.sha256);
  assert.equal(entry.stderr.observedBytes, entry.stderr.bytes);
  assert.ok(Buffer.isBuffer(stderr));
  assert.equal(stderr.length, entry.stderr.bytes);
  assert.equal(hash(stderr), entry.stderr.sha256);
}

export function requireConsumerNativeCaseLedger(
  evidence,
  requirements,
  fileHashes,
) {
  assert.equal(evidence.complete, true);
  assert.equal(evidence.required, requirements.length);
  assert.equal(evidence.passed, requirements.length);
  assert.deepEqual(evidence.problems, []);
  const ledger = evidence.ledger,
    files = [...new Set(requirements.map((row) => row.file))];
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.truncated, false);
  assert.equal(ledger.terminalEventCount, requirements.length);
  assert.equal(ledger.events.length, requirements.length);
  assert.equal(ledger.cases.length, requirements.length);
  assert.equal(ledger.files.length, files.length);
  const ids = new Map(
      files.map((file, index) => [file, "file-" + (index + 1)]),
    ),
    events = new Map(),
    sequences = new Set();
  for (const [index, file] of files.entries()) {
    const row = ledger.files[index];
    assert.equal(row.id, ids.get(file));
    assert.equal(row.stable, true);
    assert.ok(sha(fileHashes[file]));
    assert.deepEqual(row.before, {
      state: "present",
      sha256: fileHashes[file],
    });
    assert.deepEqual(row.after, row.before);
  }
  for (const event of ledger.events) {
    assert.equal(event.kind, "test");
    assert.equal(event.required, true);
    assert.equal(event.nameTruncated, false);
    assert.equal(event.outcome, "passed");
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    assert.ok(
      Number.isSafeInteger(event.sequence) &&
        event.sequence >= 1 &&
        event.sequence <= requirements.length,
    );
    assert.equal(sequences.has(event.sequence), false);
    sequences.add(event.sequence);
    const key = JSON.stringify([event.fileId, event.name]);
    assert.equal(events.has(key), false);
    events.set(key, event);
  }
  const expected = requirements
    .map((row) => JSON.stringify([ids.get(row.file), row.name]))
    .sort();
  assert.deepEqual([...events.keys()].sort(), expected);
  assert.deepEqual(
    ledger.cases.map((row) => JSON.stringify([row.fileId, row.name])).sort(),
    expected,
  );
  for (const row of ledger.cases) {
    assert.equal(row.outcome, "passed");
    assert.deepEqual(row.terminalSequences, [
      events.get(JSON.stringify([row.fileId, row.name])).sequence,
    ]);
  }
  return evidence;
}
function requireCI(ci, hosted = false) {
  assert.equal(ci.metadataAttested, false);
  if (ci.kind === "local-operator-metadata") {
    assert.equal(
      hosted,
      false,
      "Full CI aggregation requires its actual workflow context",
    );
    assert.equal(ci.runId, null);
    assert.equal(ci.runAttempt, null);
    assert.equal(ci.job, null);
  } else {
    assert.equal(ci.kind, "github-actions-run-metadata");
    assert.match(ci.runId, /^[1-9][0-9]{0,20}$/);
    assert.match(ci.runAttempt, /^[1-9][0-9]{0,8}$/);
    assert.match(ci.job, /^[A-Za-z0-9_-]{1,128}$/);
  }
}
function expectedKeys(scope) {
  return Object.values(scope.requiredObservations)
    .flat()
    .map((key) => JSON.stringify(key))
    .sort();
}
/** Re-run native semantics and exact source/retained-byte bindings; only the later successful CI completion can finalize a capsule. */
export async function normalizeConsumerNativeCapsule({
  repository,
  scope,
  frameBefore,
  frameAfter,
  entry,
  stdout,
  stderr,
  transports,
  context,
  ci,
  selectedClangPacket = null,
}) {
  requireConsumerNativeSourceFrame(frameAfter, frameBefore);
  requireEntry(entry, stdout, stderr);
  const [manifestBytes, inventoryBytes, profilesBytes] = await Promise.all(
    [
      "docs/gate-a-consumer-witnesses.v1.json",
      "docs/gate-a-profiles.v1.json",
      "scripts/required-native-tests.json",
    ].map((file) => readFile(path.join(repository, file))),
  );
  assert.equal(hash(inventoryBytes), frameBefore.inventorySha256);
  assert.equal(hash(profilesBytes), frameBefore.requirementsSha256);
  const manifest = parse(manifestBytes),
    inventory = parse(inventoryBytes),
    profiles = parse(profilesBytes),
    selected = selectConsumerNativeAcceptance(
      manifest,
      inventory,
      profiles,
      scope.acceptanceProfile,
      scope.runtime.id,
    );
  assert.deepEqual(scope, selected);
  assert.deepEqual(entry.command, scope.command);
  requireCI(ci);
  assert.equal(context.scopeId, scope.id);
  assert.equal(context.sourceFrameSha256, hash(JSON.stringify(frameBefore)));
  assert.equal(
    context.captureKind,
    scope.selectedClang
      ? "selected-clang-producer-consumer"
      : "native-consumer",
  );
  const outer = parse(stdout);
  let collection, coverage;
  if (scope.selectedClang) {
    assert.equal(outer.profile, "cpp-extensions");
    assert.equal(outer.phase, "acceptance");
    assert.ok(selectedClangPacket);
    collection = selectedClangPacket;
    const retained = outer.acceptance.consumerWitnesses,
      raw = Buffer.from(JSON.stringify(collection) + "\n");
    assert.equal(retained.retainedReceipt.bytes, raw.length);
    assert.equal(retained.retainedReceipt.sha256, hash(raw));
    assert.deepEqual(retained.binding, collection.binding);
    assert.deepEqual(
      collection.binding.code,
      await captureSelectedClangConsumerCode(),
    );
    assert.equal(
      collection.binding.definitionSha256,
      hash(
        await readFile(
          path.join(repository, "scripts/verify-cpp-extensions-container.mjs"),
        ),
      ),
    );
    coverage = await inspectSelectedClangConsumerWitnesses(
      collection,
      collection.binding,
    );
    requireSelectedClangConsumerWitnesses(coverage);
  } else {
    collection =
      outer.profile === "native-consumer-witness-collection-v1"
        ? outer
        : (outer.consumerWitnesses ?? outer.consumerRuntime?.consumerWitnesses);
    assert.equal(collection?.profile, "native-consumer-witness-collection-v1");
    assert.equal(
      collection.compiledEngine.treeSha256,
      frameBefore.engineSha256,
    );
    assert.equal(
      collection.compiledEngine.beforeAfterByteIdentitiesMatch,
      true,
    );
    assert.ok(
      collection.observations.every((row) =>
        scope.families.includes(row.family),
      ),
      "Foreign family in native scope packet",
    );
    for (const family of scope.families) {
      const code = await captureConsumerWitnessCode(repository, family);
      assert.equal(code.engineSha256, frameBefore.engineSha256);
      assert.equal(
        code.packageManifestSha256,
        frameBefore.packageManifestSha256,
      );
      for (const row of collection.observations.filter(
        (row) => row.family === family,
      ))
        for (const field of [
          "engineSha256",
          "harnessSha256",
          "requirementsSha256",
          "acceptanceSha256",
          "packageManifestSha256",
        ])
          assert.equal(
            row.code[field],
            code[field],
            "Native witness belongs to another current " + field,
          );
      for (const binding of collection.bindings.filter(
        (row) => row.family === family,
      )) {
        for (const field of [
          "engineSha256",
          "harnessSha256",
          "requirementsSha256",
          "acceptanceSha256",
          "packageManifestSha256",
        ])
          assert.equal(binding[field], code[field]);
        if (binding.runtimeImage.kind === "oci-image-observation")
          assert.equal(
            binding.runtimeImage.definitionSha256,
            code.definitionSha256,
          );
      }
    }
    coverage = inspectConsumerWitnesses(
      manifest,
      inventory,
      profiles,
      collection.observations,
      collection.bindings,
      collection.attemptRecords,
    );
    assert.deepEqual(coverage.issues, []);
    for (const family of scope.families) {
      if (project.has(family))
        requireQualifiedConsumerWitnessSlot(coverage, family, scope.runtime.id);
      else requireQualifiedConsumerWitnessFamily(coverage, family);
    }
  }
  const requirements =
      profiles[
        scope.selectedClang ? "cpp-extensions" : scope.acceptanceProfile
      ],
    fileHashes = Object.fromEntries(
      await Promise.all(
        [...new Set(requirements.map((row) => row.file))].map(async (file) => [
          file,
          hash(await readFile(path.join(repository, file))),
        ]),
      ),
    );
  requireConsumerNativeCaseLedger(
    collection.evidence,
    requirements,
    fileHashes,
  );
  const journals = reconcileConsumerNativeJournals(transports, context),
    linkage = requireConsumerNativeJournalCollection(collection, journals),
    observations = collection.observations.filter(
      (row) => scope.selectedClang || row.phase === "canonical",
    ),
    witnesses = observations.map((row) => ({
      key: address(scope, row),
      witnessId: row.witnessId,
      sha256: hash(JSON.stringify(row)),
    }));
  assert.deepEqual(
    witnesses.map((row) => JSON.stringify(row.key)).sort(),
    expectedKeys(scope),
    "Missing duplicate or foreign native source/fresh scenario",
  );
  const capsule = {
    schemaVersion: 1,
    profile: "native-consumer-scope-capsule-v1",
    scope: consumerNativeScopeSummary(scope),
    source: frameBefore,
    attemptId: context.attemptId,
    ci,
    controller: {
      moduleCompleted: true,
      processExitObserved: false,
      stdoutSha256: entry.stdout.sha256,
      stdoutBytes: entry.stdout.bytes,
      stderrSha256: entry.stderr.sha256,
      stderrBytes: entry.stderr.bytes,
      requiresSuccessfulOuterJob: true,
    },
    witnesses,
    observationCount: collection.observations.length,
    attemptRecords: collection.attemptRecords.length,
    attemptIds: collection.attemptRecords
      .map((row) => row.value.attemptId)
      .sort(),
    journalManifestSha256: linkage.manifestSha256,
    registrySha256s: journals.registries.map((row) => row.sha256).sort(),
    semanticEvidenceSha256: hash(
      JSON.stringify({
        observations: collection.observations,
        attemptRecords: collection.attemptRecords,
        bindings: collection.bindings ?? collection.binding,
      }),
    ),
    scopeComplete: true,
    arbitraryApplicationSemanticsVerified: false,
    currentNativeMatrixComplete: false,
    wholeUpstreamClosureVerified: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
  capsule.capsuleSha256 = hash(JSON.stringify(capsule));
  return capsule;
}
export function validateConsumerNativeCapsule(capsule, scope, expectedSource) {
  requireCI(capsule.ci);
  assert.equal(capsule?.schemaVersion, 1);
  assert.equal(capsule.profile, "native-consumer-scope-capsule-v1");
  requireConsumerNativeSourceFrame(capsule.source, expectedSource);
  assert.deepEqual(capsule.scope, consumerNativeScopeSummary(scope));
  const { capsuleSha256, ...body } = capsule;
  assert.ok(sha(capsuleSha256));
  assert.equal(
    capsuleSha256,
    hash(JSON.stringify(body)),
    "Native capsule bytes were altered",
  );
  assert.match(
    capsule.attemptId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(capsule.scopeComplete, true);
  assert.equal(capsule.controller.moduleCompleted, true);
  assert.equal(capsule.controller.processExitObserved, false);
  assert.equal(capsule.controller.requiresSuccessfulOuterJob, true);
  for (const field of [
    "arbitraryApplicationSemanticsVerified",
    "currentNativeMatrixComplete",
    "wholeUpstreamClosureVerified",
    "hostAttestationPerformed",
    "gateAComplete",
    "inferenceInvoked",
    "fieldEvaluationExecuted",
  ])
    assert.equal(capsule[field], false);
  assert.ok(
    Number.isSafeInteger(capsule.controller.stdoutBytes) &&
      capsule.controller.stdoutBytes > 0 &&
      capsule.controller.stdoutBytes <= 32 * 1048576,
  );
  assert.ok(
    capsule.controller.stdoutBytes + capsule.controller.stderrBytes <=
      32 * 1048576,
  );
  assert.ok(
    Number.isSafeInteger(capsule.controller.stderrBytes) &&
      capsule.controller.stderrBytes >= 0 &&
      capsule.controller.stderrBytes <= 32 * 1048576,
  );
  assert.ok(
    sha(capsule.controller.stdoutSha256) &&
      sha(capsule.controller.stderrSha256) &&
      sha(capsule.journalManifestSha256) &&
      sha(capsule.semanticEvidenceSha256),
  );
  assert.ok(
    Array.isArray(capsule.registrySha256s) &&
      capsule.registrySha256s.length > 0 &&
      capsule.registrySha256s.every(sha),
  );
  assert.ok(
    Number.isSafeInteger(capsule.observationCount) &&
      capsule.observationCount >= capsule.witnesses.length &&
      capsule.observationCount <= 512,
  );
  assert.ok(
    Number.isSafeInteger(capsule.attemptRecords) &&
      capsule.attemptRecords > 0 &&
      capsule.attemptRecords <= 2048,
  );
  assert.ok(
    Array.isArray(capsule.attemptIds) &&
      capsule.attemptIds.length === capsule.attemptRecords &&
      new Set(capsule.attemptIds).size === capsule.attemptIds.length,
  );
  for (const id of capsule.attemptIds)
    assert.match(
      id,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  assert.deepEqual(
    capsule.witnesses.map((row) => JSON.stringify(row.key)).sort(),
    expectedKeys(scope),
  );
  for (const row of capsule.witnesses) {
    assert.match(row.witnessId, /^[a-f0-9-]{36}$/);
    assert.ok(sha(row.sha256));
  }
  assert.equal(
    new Set(capsule.witnesses.map((row) => row.witnessId)).size,
    capsule.witnesses.length,
  );
  return capsule;
}
export function consumerNativeScopeJob(scope) {
  return scope.acceptanceProfile === "consumer-impact"
    ? scope.runtime.id === "native-linux-arm64-node22"
      ? "tasks-runtime-arm64"
      : "tasks-runtime"
    : scope.acceptanceProfile === "javascript-extensions"
      ? "javascript-extensions-arm64"
      : scope.selectedClang
        ? "cpp-extensions-arm64"
        : ["context-go", "context-python"].includes(scope.acceptanceProfile)
          ? "go-workspaces-arm64"
          : scope.families[0] + "-context-arm64";
}
export const consumerNativeScopeLane = (scope) =>
  consumerNativeScopeJob(scope) === "tasks-runtime"
    ? scope.runtime.id
    : "single";
/** Actual retained platform outputs select producer executions; artifact age, replay-cloned job IDs and aggregate attempt numbers do not. */
export function selectConsumerNativeProducerClaims({
  scopes,
  selectedJobs,
  completedJobs,
  source,
  ci,
}) {
  validateConsumerNativeSourceFrame(source);
  requireCI(ci, true);
  const selected = scopes.filter(
      (scope) => selectedJobs[consumerNativeScopeJob(scope)] === true,
    ),
    groups = new Map();
  for (const scope of selected) {
    const job = consumerNativeScopeJob(scope),
      lane = consumerNativeScopeLane(scope),
      key = job + ":" + lane;
    if (!groups.has(key)) groups.set(key, { job, lane, scopes: [] });
    groups.get(key).scopes.push(scope);
  }
  const checkedJobs = new Set(),
    artifacts = new Set(),
    nonces = new Set(),
    bindings = [];
  for (const group of groups.values()) {
    const { job, lane } = group,
      completed = completedJobs[job];
    assert.equal(
      completed?.result,
      "success",
      "Native scope outer job is failed skipped unavailable or incomplete",
    );
    if (!checkedJobs.has(job)) {
      const lanes = [...groups.values()]
        .filter((row) => row.job === job)
        .map((row) => row.lane)
        .sort();
      assert.deepEqual(
        lanes,
        consumerNativeJobLanes(job).sort(),
        "Frozen native job lane inventory differs",
      );
      const expected = lanes
        .flatMap((lane) =>
          Object.values(consumerNativeJobOutputKeys(job, lane)),
        )
        .sort();
      assert.ok(completed.outputs && typeof completed.outputs === "object");
      assert.deepEqual(
        Object.keys(completed.outputs).sort(),
        expected,
        "Native START or FINISH output is missing foreign or duplicated",
      );
      checkedJobs.add(job);
    }
    const names = consumerNativeJobOutputKeys(job, lane),
      decode = (name) => {
        const raw = completed.outputs[name];
        assert.ok(
          typeof raw === "string" &&
            Buffer.byteLength(raw) > 0 &&
            Buffer.byteLength(raw) <= 16384,
          "Native producer output missing or oversized",
        );
        const value = JSON.parse(raw);
        assert.equal(
          JSON.stringify(value),
          raw,
          "Native producer output is not canonical",
        );
        return value;
      },
      start = decode(names.start),
      finish = decode(names.finish);
    requireConsumerNativeProducerClaims(start, finish, {
      ci,
      source,
      job,
      lane,
      scopes: group.scopes,
    });
    assert.equal(
      artifacts.has(finish.artifact.id),
      false,
      "Reused native artifact ID",
    );
    assert.equal(
      nonces.has(start.nonce),
      false,
      "Reused native producer START nonce",
    );
    artifacts.add(finish.artifact.id);
    nonces.add(start.nonce);
    bindings.push({ ...group, start, finish });
  }
  return bindings;
}
/** Only a complete selected inventory plus independently successful outer jobs can close this consumer matrix. */
export function aggregateConsumerNativeCapsules({
  manifest,
  inventory,
  profiles,
  source,
  capsules,
  selectedJobs,
  completedJobs,
  ci,
}) {
  validateConsumerNativeSourceFrame(source);
  requireCI(ci, true);
  const all = consumerNativeAcceptanceScopes(manifest, inventory, profiles),
    selected = all.filter(
      (scope) => selectedJobs[consumerNativeScopeJob(scope)] === true,
    ),
    seen = new Map(),
    attempts = new Set(),
    witnessIds = new Set(),
    nativeAttemptIds = new Set(),
    registryHashes = new Set();
  const producerBindings = selectConsumerNativeProducerClaims({
    scopes: all,
    selectedJobs,
    completedJobs,
    source,
    ci,
  });
  assert.ok(Array.isArray(capsules) && capsules.length <= all.length);
  for (const capsule of capsules) {
    const scope = selected.find((scope) => scope.id === capsule.scope?.id);
    assert.ok(scope, "Capsule is foreign or belongs to an unselected scope");
    validateConsumerNativeCapsule(capsule, scope, source);
    assert.equal(seen.has(scope.id), false, "Duplicate native matrix scope");
    assert.equal(
      attempts.has(capsule.attemptId),
      false,
      "Reused native matrix attempt",
    );
    seen.set(scope.id, capsule);
    attempts.add(capsule.attemptId);
    for (const id of capsule.witnesses.map((row) => row.witnessId)) {
      assert.equal(witnessIds.has(id), false, "Reused native matrix witness");
      witnessIds.add(id);
    }
    for (const id of capsule.attemptIds) {
      assert.equal(
        nativeAttemptIds.has(id),
        false,
        "Reused native process attempt",
      );
      nativeAttemptIds.add(id);
    }
    for (const digest of capsule.registrySha256s) {
      assert.equal(
        registryHashes.has(digest),
        false,
        "Reused native capture registry",
      );
      registryHashes.add(digest);
    }
    assert.equal(capsule.ci.kind, "github-actions-run-metadata");
    assert.equal(capsule.ci.metadataAttested, false);
    assert.equal(capsule.ci.runId, ci.runId);
    const producer = producerBindings.find((row) =>
      row.scopes.some((candidate) => candidate.id === scope.id),
    );
    assert.ok(producer);
    const bound = producer.finish.capsules.find(
      (row) => row.scopeId === scope.id,
    );
    assert.equal(capsule.ci.runAttempt, producer.start.runAttempt);
    assert.equal(
      capsule.capsuleSha256,
      bound.sha256,
      "Native capsule does not match its selected immutable artifact claim",
    );
    assert.equal(capsule.attemptId, bound.attemptId);

    assert.equal(capsule.ci.job, consumerNativeScopeJob(scope));
    assert.equal(
      completedJobs[capsule.ci.job]?.result,
      "success",
      "Native scope outer job is failed skipped unavailable or incomplete",
    );
  }
  assert.deepEqual(
    [...seen.keys()].sort(),
    selected.map((scope) => scope.id).sort(),
    "Selected native matrix source/fresh capsules remain missing",
  );
  return {
    schemaVersion: 1,
    profile: "current-source-native-consumer-matrix-v1",
    source,
    selectedScopes: selected.map((scope) => scope.id),
    unselectedScopes: all
      .filter((scope) => !seen.has(scope.id))
      .map((scope) => scope.id),
    scopeCapsules: selected.map((scope) => ({
      id: scope.id,
      sha256: seen.get(scope.id).capsuleSha256,
    })),
    producerArtifacts: producerBindings.map((row) => ({
      job: row.job,
      lane: row.lane,
      producerAttempt: row.start.runAttempt,
      ...row.finish.artifact,
    })),
    allDeclaredScopesComplete: selected.length === all.length,
    consumerProfileComplete: selected.length === all.length,
    wholeUpstreamClosureVerified: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}
