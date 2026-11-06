// Operator observation limits are independent of the original producer profile.
import assert from "node:assert/strict";
import { replayGccJobEnvelope } from "./gcc-job-envelope.mjs";
import { observedCProducerTerminal } from "../qualify-c-producer.mjs";
import {
  cProducerProfileKey,
  cProducerExecutionPolicyBinding,
  validateCProducerExecutionPolicy,
} from "./c-producer-profile.mjs";
import { performance } from "node:perf_hooks";

export const gccCarrierLimits = Object.freeze({
  observationSeconds: 14700,
  cleanupSeconds: 600,
  softStopSeconds: 480,
  logBytes: 8 * 1024 ** 2,
});

export function requireCObservationProfile(name) {
  assert.ok(
    ["gcc-12", "glibc", "glibc-u13"].includes(name),
    "Unknown C observation profile",
  );
  return name;
}

export function validateCStartupProfile(
  startup,
  name,
  profile,
  catalogSha256,
  executionPolicy = null,
) {
  requireCObservationProfile(name);
  assert.equal(
    name,
    cProducerProfileKey(profile),
    "Startup key/source tuple differs",
  );
  assert.deepEqual(
    startup.selectedProfile,
    {
      name,
      profile: profile.profile,
      sourceVersion: profile.sourceVersion,
      catalogSha256,
    },
    "Startup does not bind the selected original profile",
  );
  if (executionPolicy)
    assert.deepEqual(
      startup.executionPolicy,
      cProducerExecutionPolicyBinding(executionPolicy, profile),
    );
  else
    assert.ok(
      !Object.hasOwn(startup, "executionPolicy"),
      "Legacy startup cannot select a local execution policy",
    );
}

export function validateGccCarrierReceipt(
  receipt,
  profile,
  catalogSha256,
  jobResponse = null,
) {
  assert.equal(profile.sourcePackage, "gcc-12");
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.selectedProfile, {
    name: "gcc-12",
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256,
  });
  assert.equal(
    receipt.originalCommandDeadlineSeconds,
    profile.limits.deadlineSeconds,
  );
  assert.equal(receipt.originalCommandDeadlineSeconds, 43200);
  let selectedLimits = gccCarrierLimits;
  if (Object.hasOwn(receipt, "githubJobEnvelope")) {
    assert.ok(jobResponse, "Retained fresh source-job response required");
    const admitted = replayGccJobEnvelope(
      receipt.githubJobEnvelope,
      jobResponse,
    );
    assert.equal(admitted.carrierStartedAt, receipt.startedAt);
    assert.equal(admitted.cutoffAt, receipt.cutoffAt);
    selectedLimits = {
      ...gccCarrierLimits,
      observationSeconds: admitted.observationSeconds,
    };
  } else assert.equal(jobResponse, null, "Unbound source-job response");
  assert.deepEqual(receipt.carrierLimits, selectedLimits);
  assert.equal(receipt.originalProducerDefaultsOrBudgetChanged, false);
  return validateCarrierRuntime(receipt, selectedLimits);
}

function validateCarrierRuntime(receipt, selectedLimits) {
  assert.equal(receipt.state, "original-controller-terminal-observed");
  assert.equal(
    receipt.stopCause,
    null,
    "External carrier cutoff cannot qualify a completed observation",
  );
  assert.ok(observedCProducerTerminal(receipt.controllerObserver));
  assert.equal(receipt.controllerObserver.exitCode, 2);
  assert.ok(
    receipt.log.bytes > 0 && receipt.log.bytes <= selectedLimits.logBytes,
  );
  assert.equal(receipt.controllerObserver.retainedBytes, receipt.log.bytes);
  assert.match(receipt.log.sha256, /^[a-f0-9]{64}$/u);
  assert.match(
    receipt.ownerAttempt,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  for (const name of ["producer", "retention"]) {
    assert.ok(["absent", "removed"].includes(receipt.cleanup[name].state));
    const id = receipt.cleanup[name].id;
    assert.ok(
      typeof id === "string" &&
        (/^[a-f0-9]{64}$/u.test(id) ||
          id === "checktrail-" + name + "-" + receipt.ownerAttempt),
    );
  }
  assert.ok(
    Number.isFinite(receipt.controllerTerminalSeconds) &&
      receipt.controllerTerminalSeconds >= 0 &&
      receipt.controllerTerminalSeconds <= selectedLimits.observationSeconds,
  );
  assert.ok(
    Number.isFinite(receipt.elapsedSeconds) &&
      receipt.elapsedSeconds >= receipt.controllerTerminalSeconds &&
      receipt.elapsedSeconds <=
        selectedLimits.observationSeconds + selectedLimits.cleanupSeconds,
  );
  assert.ok(
    Number.isFinite(receipt.cleanupStartedSeconds) &&
      receipt.cleanupStartedSeconds >= receipt.controllerTerminalSeconds &&
      receipt.cleanupStartedSeconds <= receipt.elapsedSeconds,
  );
  assert.ok(
    Number.isFinite(receipt.cleanupDeadlineSeconds) &&
      receipt.cleanupDeadlineSeconds >= receipt.cleanupStartedSeconds &&
      receipt.cleanupDeadlineSeconds <=
        receipt.cleanupStartedSeconds + selectedLimits.cleanupSeconds &&
      receipt.cleanupDeadlineSeconds <=
        selectedLimits.observationSeconds + selectedLimits.cleanupSeconds &&
      receipt.elapsedSeconds <= receipt.cleanupDeadlineSeconds,
    "Carrier cleanup clock was reset or exceeded",
  );
  const stop = receipt.stopObservation;
  assert.equal(stop.ownerAdmissionError, null);
  for (const flag of [
    "childTerminalObserved",
    "childReaped",
    "familyAbsent",
    "softFamilyAbsent",
  ])
    assert.equal(
      stop[flag],
      true,
      "Complete owned process-family quiescence is required",
    );
  assert.ok(
    Number.isSafeInteger(stop.processGroupId) && stop.processGroupId > 0,
  );
  if (Object.hasOwn(stop, "pendingGroupProbes")) {
    const pending = stop.pendingGroupProbes;
    assert.ok(
      Number.isSafeInteger(pending.count) &&
        pending.count > 0 &&
        pending.count <= 20000,
    );
    assert.deepEqual(pending, {
      operation: "signal-zero",
      code: "EPERM",
      count: pending.count,
      absenceInferred: false,
      signallingAuthorized: false,
    });
  }
  for (const name of ["startedAt", "cutoffAt"])
    assert.ok(
      typeof receipt[name] === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt[name]) &&
        Number.isFinite(Date.parse(receipt[name])),
      "Carrier UTC framing",
    );
  assert.equal(
    Date.parse(receipt.cutoffAt),
    Date.parse(receipt.startedAt) + selectedLimits.observationSeconds * 1000,
  );
  for (const flag of [
    "fullEightHourHostedCapacityVerified",
    "originalCommandCompletionClaimed",
    "fullCompilerSdkBootstrapClosureVerified",
    "completeOriginalNoticeClosureVerified",
    "historicalPublisherConsumptionVerified",
    "gateAComplete",
  ])
    assert.equal(receipt[flag], false);
  return {
    originalControllerTerminalObserved: true,
    originalCommandCompletionClaimed: false,
    fullEightHourHostedCapacityVerified: false,
    gateAComplete: false,
  };
}

export function localGccCarrierLimits(policy, profile) {
  validateCProducerExecutionPolicy(policy, profile);
  return Object.freeze({
    ...gccCarrierLimits,
    observationSeconds: policy.windows.localForegroundObservationSeconds,
    cleanupSeconds: policy.windows.localForegroundCleanupSeconds,
  });
}
const canonicalUtc = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

// These are operator declarations, not an attestation of a managed runner.
// Capture UTC only once. Later phases consume that original remainder using
// this process's monotonic clock, including time spent preparing the carrier.
export function captureLocalGccManagedClock(
  policy,
  profile,
  managedStartedAt,
  managedDeadlineAt,
  capturedAt,
  monotonicStarted,
) {
  validateCProducerExecutionPolicy(policy, profile);
  assert.ok(
    [managedStartedAt, managedDeadlineAt, capturedAt].every(canonicalUtc),
    "Malformed operator-declared managed window",
  );
  const windows = policy.windows;
  assert.equal(
    Date.parse(managedDeadlineAt) - Date.parse(managedStartedAt),
    windows.managedMaximumSeconds * 1000,
    "Managed window must be exactly24hours",
  );
  const remainingAtCaptureMs =
    Date.parse(managedDeadlineAt) - Date.parse(capturedAt);
  const initialElapsedMs =
    Date.parse(capturedAt) - Date.parse(managedStartedAt);
  assert.ok(
    initialElapsedMs >= 0 &&
      initialElapsedMs <= windows.managedBootstrapAdmissionSeconds * 1000,
    "Future or stale operator-declared managed origin",
  );
  assert.ok(
    Number.isFinite(monotonicStarted) &&
      monotonicStarted >= 0 &&
      monotonicStarted <= performance.now(),
    "Malformed local carrier monotonic origin",
  );
  let admitted = null;
  const elapsed = () => Math.ceil(performance.now() - monotonicStarted);
  const requiredAtAdmissionMs =
    (windows.localForegroundObservationSeconds +
      windows.localForegroundCleanupSeconds +
      windows.minimumExportReplayReserveSeconds) *
    1000;
  return Object.freeze({
    admit() {
      assert.equal(
        admitted,
        null,
        "Local carrier native admission is one-shot",
      );
      const monotonicAdmissionMs = elapsed();
      assert.ok(
        initialElapsedMs + monotonicAdmissionMs <=
          windows.managedBootstrapAdmissionSeconds * 1000 &&
          remainingAtCaptureMs - monotonicAdmissionMs >= requiredAtAdmissionMs,
        "Insufficient original managed remainder for local observation, cleanup and export",
      );
      admitted = Object.freeze({
        monotonicAdmissionMs,
        remainingAtAdmissionMs: remainingAtCaptureMs - monotonicAdmissionMs,
        requiredAtAdmissionMs,
      });
      return admitted;
    },
    remainingMs: () => Math.max(0, remainingAtCaptureMs - elapsed()),
    snapshot() {
      const monotonicElapsedMs = elapsed();
      return {
        schemaVersion: 1,
        authority: "operator-declared-managed-window",
        clockScope: "one-UTC-capture-then-same-carrier-monotonic",
        managedStartedAt,
        managedDeadlineAt,
        capturedAt,
        remainingAtCaptureMs,
        admission: admitted,
        monotonicElapsedMs,
        remainingAtFinishMs: Math.max(
          0,
          remainingAtCaptureMs - monotonicElapsedMs,
        ),
        independentlyAttestedManagedLease: false,
      };
    },
  });
}

export function validateLocalGccManagedWindow(value, policy, profile) {
  validateCProducerExecutionPolicy(policy, profile);
  const windows = policy.windows;
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "schemaVersion",
      "authority",
      "clockScope",
      "managedStartedAt",
      "managedDeadlineAt",
      "capturedAt",
      "remainingAtCaptureMs",
      "admission",
      "monotonicElapsedMs",
      "remainingAtFinishMs",
      "independentlyAttestedManagedLease",
    ].sort(),
  );
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.authority, "operator-declared-managed-window");
  assert.equal(value.clockScope, "one-UTC-capture-then-same-carrier-monotonic");
  assert.equal(value.independentlyAttestedManagedLease, false);
  assert.ok(
    [value.managedStartedAt, value.managedDeadlineAt, value.capturedAt].every(
      canonicalUtc,
    ),
    "Malformed retained operator window",
  );
  assert.equal(
    Date.parse(value.managedDeadlineAt) - Date.parse(value.managedStartedAt),
    windows.managedMaximumSeconds * 1000,
  );
  const initialElapsed =
    Date.parse(value.capturedAt) - Date.parse(value.managedStartedAt);
  assert.ok(
    initialElapsed >= 0 &&
      initialElapsed <= windows.managedBootstrapAdmissionSeconds * 1000,
  );
  assert.equal(
    value.remainingAtCaptureMs,
    Date.parse(value.managedDeadlineAt) - Date.parse(value.capturedAt),
  );
  const admission = value.admission;
  assert.deepEqual(
    Object.keys(admission).sort(),
    [
      "monotonicAdmissionMs",
      "remainingAtAdmissionMs",
      "requiredAtAdmissionMs",
    ].sort(),
  );
  assert.ok(
    admission &&
      Number.isSafeInteger(admission.monotonicAdmissionMs) &&
      admission.monotonicAdmissionMs >= 0 &&
      initialElapsed + admission.monotonicAdmissionMs <=
        windows.managedBootstrapAdmissionSeconds * 1000,
  );
  assert.equal(
    admission.requiredAtAdmissionMs,
    (windows.localForegroundObservationSeconds +
      windows.localForegroundCleanupSeconds +
      windows.minimumExportReplayReserveSeconds) *
      1000,
  );
  assert.equal(
    admission.remainingAtAdmissionMs,
    value.remainingAtCaptureMs - admission.monotonicAdmissionMs,
  );
  assert.ok(
    admission.remainingAtAdmissionMs >= admission.requiredAtAdmissionMs,
  );
  assert.ok(
    Number.isSafeInteger(value.monotonicElapsedMs) &&
      value.monotonicElapsedMs >= admission.monotonicAdmissionMs,
  );
  assert.equal(
    value.remainingAtFinishMs,
    Math.max(0, value.remainingAtCaptureMs - value.monotonicElapsedMs),
  );
  assert.ok(
    value.remainingAtFinishMs >=
      windows.minimumExportReplayReserveSeconds * 1000,
    "Original managed export/replay reserve exhausted",
  );
  return value;
}

export function validateLocalGccCarrierReceipt(
  receipt,
  profile,
  catalogSha256,
  policy,
) {
  validateCProducerExecutionPolicy(policy, profile);
  assert.equal(receipt.schemaVersion, 2);
  assert.ok(
    !Object.hasOwn(receipt, "githubJobEnvelope") &&
      !Object.hasOwn(receipt, "originalProducerDefaultsOrBudgetChanged"),
    "Local carrier cannot masquerade as hosted/legacy observation",
  );
  assert.deepEqual(
    receipt.executionPolicy,
    cProducerExecutionPolicyBinding(policy, profile),
  );
  assert.deepEqual(receipt.selectedProfile, {
    name: "gcc-12",
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256,
  });
  assert.equal(
    receipt.originalCommandDeadlineSeconds,
    policy.native.deadlineSeconds,
  );
  assert.equal(receipt.sourceProfileDefaultsChanged, false);
  assert.equal(receipt.executionPolicyChangesWallDeadline, true);
  const limits = localGccCarrierLimits(policy, profile);
  assert.deepEqual(receipt.carrierLimits, limits);
  validateLocalGccManagedWindow(receipt.managedWindow, policy, profile);
  assert.equal(receipt.managedWindow.capturedAt, receipt.startedAt);
  assert.equal(
    receipt.managedWindow.monotonicElapsedMs,
    Math.round(receipt.elapsedSeconds * 1000),
  );
  return validateCarrierRuntime(receipt, limits);
}
