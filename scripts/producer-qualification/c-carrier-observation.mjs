// Operator observation limits are independent of the original producer profile.
import assert from "node:assert/strict";
import { observedCProducerTerminal } from "../qualify-c-producer.mjs";

export const gccCarrierLimits = Object.freeze({
  observationSeconds: 14700,
  cleanupSeconds: 600,
  softStopSeconds: 480,
  logBytes: 8 * 1024 ** 2,
});

export function requireCObservationProfile(name) {
  assert.ok(
    ["gcc-12", "glibc"].includes(name),
    "Unknown C observation profile",
  );
  return name;
}

export function validateCStartupProfile(startup, name, profile, catalogSha256) {
  requireCObservationProfile(name);
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
}

export function validateGccCarrierReceipt(receipt, profile, catalogSha256) {
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
  assert.equal(receipt.originalCommandDeadlineSeconds, 28800);
  assert.deepEqual(receipt.carrierLimits, gccCarrierLimits);
  assert.equal(receipt.state, "original-controller-terminal-observed");
  assert.equal(
    receipt.stopCause,
    null,
    "External carrier cutoff cannot qualify a completed observation",
  );
  assert.ok(observedCProducerTerminal(receipt.controllerObserver));
  assert.equal(receipt.controllerObserver.exitCode, 2);
  assert.ok(
    receipt.log.bytes > 0 && receipt.log.bytes <= gccCarrierLimits.logBytes,
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
      receipt.controllerTerminalSeconds <= gccCarrierLimits.observationSeconds,
  );
  assert.ok(
    Number.isFinite(receipt.elapsedSeconds) &&
      receipt.elapsedSeconds >= receipt.controllerTerminalSeconds &&
      receipt.elapsedSeconds <=
        gccCarrierLimits.observationSeconds + gccCarrierLimits.cleanupSeconds,
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
        receipt.cleanupStartedSeconds + gccCarrierLimits.cleanupSeconds &&
      receipt.cleanupDeadlineSeconds <=
        gccCarrierLimits.observationSeconds + gccCarrierLimits.cleanupSeconds &&
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
    Date.parse(receipt.startedAt) + gccCarrierLimits.observationSeconds * 1000,
  );
  for (const flag of [
    "originalProducerDefaultsOrBudgetChanged",
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
