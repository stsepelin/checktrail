import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../" : "../../", import.meta.url),
);
const scripts = path.join(repository, "scripts");
const profiles = await import(
  pathToFileURL(
    path.join(scripts, "producer-qualification/c-producer-profile.mjs"),
  ).href
);
const carrier = await import(
  pathToFileURL(
    path.join(scripts, "producer-qualification/c-carrier-observation.mjs"),
  ).href
);
const producer = await import(
  pathToFileURL(path.join(scripts, "qualify-c-producer.mjs")).href
);
const { profile, catalog } = await profiles.loadCProducerProfile("gcc-12");
const id = "local-gcc12-12h-v1";
const policy = await profiles.loadCProducerExecutionPolicy(id, profile);

test("local GCC twelve-hour policy preserves the native profile and both independently pinned execution contexts", async () => {
  const original = structuredClone(profile);
  const previous = await profiles.loadCProducerExecutionPolicy(
    "local-gcc12-23h-v1",
    profile,
  );
  assert.equal(previous.native.deadlineSeconds, 82800);
  assert.equal(previous.windows.managedMaximumSeconds, 86400);
  assert.equal(
    profiles.cProducerExecutionPolicyBinding(previous, profile).sourcePin
      .sha256,
    "9356abbf7cf21ec34646c56a95158414d2832e4402797a77e5dfce0866129bd8",
  );
  const pin = profiles.cProducerExecutionPolicyPin(id);
  assert.deepEqual(pin, {
    file: "gcc-local-12h-policy.v1.json",
    sha256: "1964d3ca86505c6fc12791cd1b58d67cbb5013f20de87300371f7a4652efc3cf",
  });
  const bytes = await readFile(
    path.join(scripts, "producer-qualification", pin.file),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
  assert.deepEqual(JSON.parse(bytes.toString()), policy);
  assert.deepEqual(
    profiles.cProducerExecutionLimits(profile, policy),
    profile.limits,
  );
  assert.equal(policy.native.deadlineSeconds, 43200);
  assert.equal(policy.windows.controllerTotalSeconds, 600 + 43290 + 180 + 330);
  assert.equal(policy.windows.localForegroundObservationSeconds, 44460);
  assert.equal(policy.windows.managedMaximumSeconds, 44460 + 600 + 1200 + 540);
  assert.deepEqual(profiles.cProducerExecutionPolicyBinding(policy, profile), {
    schemaVersion: 1,
    id,
    context: "operator-local-arm64-managed-window",
    sourcePin: pin,
    executionLimits: profile.limits,
    windows: policy.windows,
  });
  assert.equal(Object.isFrozen(policy.native.command), true);
  assert.equal(Object.isFrozen(policy.native), true);
  assert.equal(Object.isFrozen(pin), true);
  for (const unknown of [
    "local-gcc12-12h",
    "local-gcc12-12h-v2",
    "__proto__",
    "",
    12,
  ])
    await assert.rejects(
      profiles.loadCProducerExecutionPolicy(unknown, profile),
      /Unknown closed/,
    );
  assert.deepEqual(profile, original);
});

test("local GCC twelve-hour policy rejects changed limits, reserves and foreign source profiles", async () => {
  for (const [section, field, value] of [
    ["native", "deadlineSeconds", 43199],
    ["native", "deadlineSeconds", 43201],
    ["native", "cpuLimit", 5],
    ["native", "memory", "7g"],
    ["native", "pidsLimit", 1025],
    ["native", "workByteLimit", 68719476737],
    ["native", "logByteLimit", 536870913],
    ["windows", "controllerTotalSeconds", 44399],
    ["windows", "minimumExportReplayReserveSeconds", 1199],
    ["windows", "managedMaximumSeconds", 86400],
    ["requires", "hostedJobEnvelope", true],
  ] as const) {
    const changed = structuredClone(policy);
    changed[section][field] = value;
    assert.throws(
      () => profiles.validateCProducerExecutionPolicy(changed, profile),
      /Unknown or modified/,
    );
  }
  const downgraded = structuredClone(policy);
  downgraded.id = "local-gcc12-23h-v1";
  assert.throws(
    () => profiles.validateCProducerExecutionPolicy(downgraded, profile),
    /Unknown or modified/,
  );
  for (const name of ["glibc", "glibc-u13"]) {
    const other = await profiles.loadCProducerProfile(name);
    await assert.rejects(
      profiles.loadCProducerExecutionPolicy(id, other.profile),
      /GCC12-only/,
    );
  }
});

test("local GCC twelve-hour admission uses the actual command timeout and requires operator execution permission", () => {
  const base = [
    "--profile",
    "gcc-12",
    "--inputs",
    "/synthetic/inputs",
    "--output",
    "/synthetic/output",
  ];
  assert.deepEqual(
    producer.cProducerExecutionOptions([
      ...base,
      "--operator-trust-execution",
      "--coordinated-heavy-slot",
      "--allow-local-arm64-daemon",
      "--execution-policy",
      id,
    ]),
    { prepare: false, allowLocalArm64Daemon: true, executionPolicyId: id },
  );
  assert.throws(
    () =>
      producer.cProducerExecutionOptions([
        ...base,
        "--operator-trust-execution",
        "--coordinated-heavy-slot",
        "--execution-policy",
        id,
      ]),
    /explicit ARM daemon permission/,
  );
  assert.throws(
    () =>
      producer.cProducerExecutionOptions([...base, "--execution-policy", id]),
    /Usage:/,
  );
  const argv = producer.cProducerArguments(
    catalog,
    profile,
    "/synthetic/output",
    "b57ee8b4-3bec-4bd1-8104-7f45a904c2b6",
    { uid: 501, gid: 20 },
    policy,
  );
  const at = argv.indexOf("/usr/bin/timeout");
  assert.notEqual(at, -1);
  assert.deepEqual(argv.slice(at, at + 4), [
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=30s",
    "43200",
  ]);
});

test("local GCC twelve-hour controller retains full execution plus recovery under one monotonic deadline", (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  const clock = profiles.cProducerExecutionClock(policy, profile, now);
  assert.equal(clock.setupRemaining(), 600000);
  now += 600000;
  assert.deepEqual(clock.admitNative(), {
    elapsedSeconds: 600,
    observerSeconds: 43290,
    recoveryReserveSeconds: 510,
  });
  assert.throws(() => clock.admitNative(), /one-shot/);
  now += 43290000;
  assert.equal(clock.collectionTimeoutMs(), 180000);
  profiles.validateCProducerExecutionClock(clock.snapshot(), profile, policy);
  now += 180000;
  assert.throws(
    () => clock.collectionTimeoutMs(),
    /recovery allowance exhausted/,
  );
  const late = profiles.cProducerExecutionClock(policy, profile, now - 600001);
  assert.throws(
    () => late.admitNative(),
    /Insufficient original controller remainder/,
  );
  const changed = structuredClone(clock.snapshot());
  changed.totalSeconds = 84000;
  assert.throws(() =>
    profiles.validateCProducerExecutionClock(changed, profile, policy),
  );
});

test("local GCC thirteen-hour managed window consumes bootstrap and export reserves without resetting them", (t) => {
  let now = 1_000_000;
  t.mock.method(performance, "now", () => now);
  const start = "2026-01-01T00:00:00.000Z",
    end = "2026-01-01T13:00:00.000Z";
  const clock = carrier.captureLocalGccManagedClock(
    policy,
    profile,
    start,
    end,
    start,
    now,
  );
  now += 540000;
  clock.admit();
  assert.throws(() => clock.admit(), /one-shot/);
  now += (44460 + 600) * 1000;
  const snapshot = clock.snapshot();
  assert.equal(snapshot.remainingAtFinishMs, 1200000);
  assert.equal(
    snapshot.admission.requiredAtAdmissionMs,
    (44460 + 600 + 1200) * 1000,
  );
  carrier.validateLocalGccManagedWindow(snapshot, policy, profile);
  now += 1;
  assert.throws(
    () =>
      carrier.validateLocalGccManagedWindow(clock.snapshot(), policy, profile),
    /export\/replay reserve exhausted/,
  );
  for (const wrong of ["2026-01-01T12:00:00.000Z", "2026-01-02T00:00:00.000Z"])
    assert.throws(
      () =>
        carrier.captureLocalGccManagedClock(
          policy,
          profile,
          start,
          wrong,
          start,
          now,
        ),
      /exactly13hours/,
    );
  const late = carrier.captureLocalGccManagedClock(
    policy,
    profile,
    start,
    end,
    "2026-01-01T00:09:00.000Z",
    now,
  );
  now += 1;
  assert.throws(() => late.admit(), /Insufficient original managed remainder/);
});

test("local GCC twelve-hour carrier cannot claim that its native wall deadline changed", (t) => {
  let now = 1000000;
  t.mock.method(performance, "now", () => now);
  const start = "2026-01-01T00:00:00.000Z";
  const clock = carrier.captureLocalGccManagedClock(
    policy,
    profile,
    start,
    "2026-01-01T13:00:00.000Z",
    start,
    now,
  );
  clock.admit();
  now += 2000;
  const limits = carrier.localGccCarrierLimits(policy, profile);
  const attempt = "12345678-1234-4234-8234-123456789012";
  const receipt = {
    schemaVersion: 2,
    selectedProfile: {
      name: "gcc-12",
      profile: profile.profile,
      sourceVersion: profile.sourceVersion,
      catalogSha256: profiles.cProducerCatalogSha256,
    },
    originalCommandDeadlineSeconds: 43200,
    carrierLimits: limits,
    state: "original-controller-terminal-observed",
    stopCause: null,
    controllerObserver: {
      exitCode: 2,
      signal: null,
      error: null,
      reason: null,
      retainedBytes: 1,
      stopError: null,
    },
    log: { bytes: 1, sha256: "1".repeat(64) },
    ownerAttempt: attempt,
    cleanup: {
      producer: { state: "absent", id: "checktrail-producer-" + attempt },
      retention: { state: "absent", id: "checktrail-retention-" + attempt },
    },
    controllerTerminalSeconds: 1,
    elapsedSeconds: 2,
    cleanupStartedSeconds: 1,
    cleanupDeadlineSeconds: 601,
    stopObservation: {
      ownerAdmissionError: null,
      childTerminalObserved: true,
      childReaped: true,
      softFamilyAbsent: true,
      familyAbsent: true,
      processGroupId: 1001,
    },
    startedAt: start,
    cutoffAt: "2026-01-01T12:21:00.000Z",
    executionPolicy: profiles.cProducerExecutionPolicyBinding(policy, profile),
    sourceProfileDefaultsChanged: false,
    executionPolicyChangesWallDeadline: false,
    managedWindow: clock.snapshot(),
    fullEightHourHostedCapacityVerified: false,
    originalCommandCompletionClaimed: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  assert.equal(
    carrier.validateLocalGccCarrierReceipt(
      receipt,
      profile,
      profiles.cProducerCatalogSha256,
      policy,
    ).gateAComplete,
    false,
  );
  receipt.executionPolicyChangesWallDeadline = true;
  assert.throws(() =>
    carrier.validateLocalGccCarrierReceipt(
      receipt,
      profile,
      profiles.cProducerCatalogSha256,
      policy,
    ),
  );
});
