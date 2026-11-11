// Development-only, closed original producer profiles. Loading executes no source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";

export const cProducerCatalogSha256 =
  "3e22395e92f732e1b30cf972c6f6d660f5e499562038ed31a342b018f8d481bd";
export const cProducerCommand = [
  "dpkg-buildpackage",
  "-b",
  "-us",
  "-uc",
  "--jobs=4",
];
export const cProducerDirectory = fileURLToPath(new URL("./", import.meta.url));
export const safeRelative = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9](?:[A-Za-z0-9.+_~/-]|%3a)*$/u.test(value) &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const profileBindings = [
  [
    "gcc-12",
    "gcc-12",
    "12.2.0-14+deb12u1",
    241,
    12,
    64,
    "source/gcc-12/gcc-12_12.2.0-14+deb12u1.dsc",
  ],
  [
    "glibc",
    "glibc",
    "2.36-9+deb12u14",
    161,
    4,
    32,
    "source/glibc/glibc_2.36-9+deb12u14.dsc",
  ],
  [
    "glibc-u13",
    "glibc",
    "2.36-9+deb12u13",
    161,
    4,
    32,
    "source/glibc/glibc_2.36-9+deb12u13.dsc",
  ],
];

export function cProducerProfileKey(profile) {
  const binding = profileBindings.find(
    ([, sourcePackage, version, , , , descriptor]) =>
      profile.sourcePackage === sourcePackage &&
      profile.sourceVersion === version &&
      profile.profile ===
        `original-debian-${sourcePackage}-${version}-build-v1` &&
      profile.descriptor === descriptor,
  );
  assert.ok(
    binding,
    "Unknown exact C producer key/source/version/descriptor tuple",
  );
  return binding[0];
}

export function validateCProducerCatalog(catalog) {
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(
    catalog.image,
    "docker.io/coqorg/coq@sha256:1f69b9224f068d408e6be7a3f536f67395d00c3497b97bdb99ee2d2c4c91954c",
  );
  assert.equal(catalog.platform, "linux/amd64");
  assert.deepEqual(catalog.environment, {
    HOME: "/work/home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    DEBIAN_FRONTEND: "noninteractive",
  });
  assert.deepEqual(Object.keys(catalog.profiles).sort(), [
    "gcc-12",
    "glibc",
    "glibc-u13",
  ]);
  assert.equal(catalog.commonInputs.length, 8);
  for (const [
    name,
    sourcePackage,
    version,
    count,
    hours,
    gib,
    descriptor,
  ] of profileBindings) {
    const profile = catalog.profiles[name];
    assert.equal(profile.sourcePackage, sourcePackage);
    assert.equal(profile.descriptor, descriptor);
    assert.equal(cProducerProfileKey(profile), name);
    assert.equal(profile.sourceVersion, version);
    assert.equal(
      profile.profile,
      `original-debian-${sourcePackage}-${version}-build-v1`,
    );
    assert.deepEqual(profile.command, cProducerCommand);
    assert.deepEqual(profile.limits, {
      cpuLimit: 4,
      memory: "6g",
      pidsLimit: 1024,
      deadlineSeconds: hours * 3600,
      logByteLimit: 512 * 1024 ** 2,
      workByteLimit: gib * 1024 ** 3,
      inputFileByteLimit: 128 * 1024 ** 2,
    });
    assert.equal(profile.reportFileByteLimit, 64 * 1024 ** 2);
    assert.equal(profile.reportAggregateByteLimit, 512 * 1024 ** 2);
    assert.equal(profile.expectedInputs, count);
    assert.equal(profile.files.length, count);
    assert.deepEqual(
      profile.generatedBuildRoots,
      name === "gcc-12"
        ? [
            "build",
            "build-cross",
            "build-jit",
            "build-nvptx",
            "build-gcn",
            "build-hppa64",
          ]
        : ["build-tree"],
    );
    if (name === "gcc-12")
      assert.deepEqual(profile.compatibilityBuildRoots, ["build-cross"]);
    else assert.equal(profile.compatibilityBuildRoots, undefined);
    const seen = new Set();
    for (const row of profile.files) {
      assert.ok(
        safeRelative(row.file) && !seen.has(row.file),
        "Invalid or duplicate closed input",
      );
      seen.add(row.file);
      assert.ok(
        Number.isSafeInteger(row.bytes) &&
          row.bytes >= 0 &&
          row.bytes <= profile.limits.inputFileByteLimit,
        "Exact profile input exceeds its declared finite bound",
      );
      assert.match(row.sha256, /^[a-f0-9]{64}$/u);
      for (const address of row.sourceUrls ?? []) {
        const url = new URL(address);
        assert.equal(url.protocol, "https:");
        assert.ok(
          ["deb.debian.org", "snapshot.debian.org"].includes(url.hostname),
        );
        assert.equal(
          url.username + url.password + url.port + url.hash + url.search,
          "",
        );
      }
    }
    assert.ok(seen.has(profile.descriptor));
    assert.ok(
      profile.files.reduce((sum, row) => sum + row.bytes, 0) <= 1024 ** 3,
    );
    for (const common of catalog.commonInputs) {
      const selected = profile.files.find((row) => row.file === common.file);
      assert.deepEqual(
        selected,
        common,
        "Shared authenticated APT/keyring pin changed",
      );
    }
    for (const field of [
      "noticeCaptureIsExhaustive",
      "sourceFilesPatched",
      "originalBuildChecksDisabled",
      "originalDefaultTargetsDisabled",
      "inputAuthenticationDisabled",
      "sourceBuildQualified",
      "completeOriginalNoticeClosureVerified",
      "historicalPublisherConsumptionVerified",
      "gateAComplete",
    ])
      assert.equal(
        profile[field],
        false,
        "Unproven producer closure must remain false: " + field,
      );
  }
  assert.deepEqual(catalog.profiles.glibc.priorDifferentSourceNotRelabeled, {
    version: "2.36-9+deb12u13",
    descriptorSha256:
      "c034e180a28197c8a9d2b378bcf621d87766a49b3d1bb2d82cc25068ba398cac",
    crossRevisionProducerClosureClaimed: false,
  });
  const u13 = catalog.profiles["glibc-u13"];
  const u14 = catalog.profiles.glibc;
  const replacements = [
    {
      file: "source/glibc/glibc_2.36-9+deb12u13.debian.tar.xz",
      bytes: 908524,
      sha256:
        "728086077548b13c37a348a99f74b9c7a437d6a8aed4aab5e2ed86b3a5ff6df6",
      kind: "original-source-archive",
      sourceUrls: [
        "https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.36-9+deb12u13.debian.tar.xz",
      ],
    },
    {
      file: "source/glibc/glibc_2.36-9+deb12u13.dsc",
      bytes: 9765,
      sha256:
        "c034e180a28197c8a9d2b378bcf621d87766a49b3d1bb2d82cc25068ba398cac",
      kind: "signed-source-descriptor",
      sourceUrls: [
        "https://deb.debian.org/debian/pool/main/g/glibc/glibc_2.36-9+deb12u13.dsc",
      ],
    },
  ];
  assert.deepEqual(
    u13.files.filter((row) =>
      replacements.some((replacement) => replacement.file === row.file),
    ),
    replacements,
    "Exact u13 source descriptor/archive pins changed",
  );
  const oldSourceNames = new Set([
    "source/glibc/glibc_2.36-9+deb12u14.debian.tar.xz",
    "source/glibc/glibc_2.36-9+deb12u14.dsc",
  ]);
  const newSourceNames = new Set(replacements.map((row) => row.file));
  assert.deepEqual(
    u13.files.filter((row) => !newSourceNames.has(row.file)),
    u14.files.filter((row) => !oldSourceNames.has(row.file)),
    "The 159 unchanged u13 bootstrap/metadata inputs changed",
  );
  assert.equal(
    u13.sourceDescriptorSigner,
    null,
    "Fresh u13 signer identity is not yet observed",
  );
  assert.equal(u13.freshSourceDescriptorSignatureVerified, false);
  assert.equal(u13.historicalPrivateInputReplayVerified, false);
  assert.equal(u13.reusedBootstrapInputProfile, u14.profile);
  assert.equal(u13.originalProducerRules.length, 48);
  assert.equal(u13.capturedOriginalNotices.length, 5);
  return catalog;
}

export async function loadCProducerProfile(name) {
  assert.ok(
    ["gcc-12", "glibc", "glibc-u13"].includes(name),
    "Unknown closed producer profile",
  );
  const bytes = await readFile(
    new URL("c-producer-profiles.v1.json", import.meta.url),
  );
  assert.ok(
    bytes.length <= 1024 ** 2,
    "Profile metadata exceeds its finite bound",
  );
  assert.equal(
    sha256(bytes),
    cProducerCatalogSha256,
    "Frozen producer metadata changed",
  );
  const catalog = validateCProducerCatalog(JSON.parse(bytes));
  return {
    catalog,
    profileKey: name,
    profile: catalog.profiles[name],
    catalogSha256: sha256(bytes),
  };
}

// This is a separate execution context, never a mutation of the frozen source
// profile. Historical/default qualifications keep their twelve-hour contract.
export const cProducerLocalPolicyId = "local-gcc12-23h-v1";
export const cProducerLocalPolicyFile = "gcc-local-wall-policy.v1.json";
export const cProducerLocalPolicySha256 =
  "9356abbf7cf21ec34646c56a95158414d2832e4402797a77e5dfce0866129bd8";
const localPolicy = {
  schemaVersion: 1,
  id: "local-gcc12-23h-v1",
  context: "operator-local-arm64-managed-window",
  base: {
    profileKey: "gcc-12",
    sourceProfile: "original-debian-gcc-12-12.2.0-14+deb12u1-build-v1",
    sourceVersion: "12.2.0-14+deb12u1",
    catalogSha256:
      "3e22395e92f732e1b30cf972c6f6d660f5e499562038ed31a342b018f8d481bd",
    deadlineSeconds: 43200,
  },
  native: {
    command: ["dpkg-buildpackage", "-b", "-us", "-uc", "--jobs=4"],
    deadlineSeconds: 82800,
    killAfterSeconds: 30,
    cpuLimit: 4,
    memory: "6g",
    pidsLimit: 1024,
    workByteLimit: 68719476736,
    logByteLimit: 536870912,
    inputFileByteLimit: 134217728,
  },
  windows: {
    controllerSetupSeconds: 600,
    producerObserverSeconds: 82890,
    postStopCollectorObserverSeconds: 180,
    controllerFinalizationReserveSeconds: 330,
    controllerTotalSeconds: 84000,
    localForegroundObservationSeconds: 84060,
    localForegroundCleanupSeconds: 600,
    minimumExportReplayReserveSeconds: 1200,
    managedBootstrapAdmissionSeconds: 540,
    managedMaximumSeconds: 86400,
  },
  requires: {
    operatorTrustExecution: true,
    coordinatedHeavySlot: true,
    localArm64Daemon: true,
    hostedJobEnvelope: false,
  },
};

// This separate carrier grants the original twelve-hour native deadline.
// Keep the historical 23-hour policy and its byte pin unchanged.
const local12hPolicy = {
  ...localPolicy,
  id: "local-gcc12-12h-v1",
  native: { ...localPolicy.native, deadlineSeconds: 43200 },
  windows: {
    ...localPolicy.windows,
    producerObserverSeconds: 43290,
    controllerTotalSeconds: 44400,
    localForegroundObservationSeconds: 44460,
    managedMaximumSeconds: 46800,
  },
};
const localPolicies = new Map([
  [localPolicy.id, localPolicy],
  [local12hPolicy.id, local12hPolicy],
]);
const localPolicyPins = new Map([
  [
    cProducerLocalPolicyId,
    Object.freeze({
      file: cProducerLocalPolicyFile,
      sha256: cProducerLocalPolicySha256,
    }),
  ],
  [
    local12hPolicy.id,
    Object.freeze({
      file: "gcc-local-12h-policy.v1.json",
      sha256:
        "1964d3ca86505c6fc12791cd1b58d67cbb5013f20de87300371f7a4652efc3cf",
    }),
  ],
]);

export function cProducerExecutionPolicyPin(id) {
  assert.ok(localPolicyPins.has(id), "Unknown closed local execution policy");
  return localPolicyPins.get(id);
}

export function validateCProducerExecutionPolicy(policy, profile) {
  const expected = localPolicies.get(policy?.id);
  assert.ok(expected, "Unknown or modified closed local execution policy");
  assert.deepEqual(
    policy,
    expected,
    "Unknown or modified closed local execution policy",
  );
  assert.equal(
    cProducerProfileKey(profile),
    "gcc-12",
    "Local execution policy is GCC12-only",
  );
  assert.equal(profile.profile, policy.base.sourceProfile);
  assert.equal(profile.sourceVersion, policy.base.sourceVersion);
  assert.deepEqual(profile.command, policy.native.command);
  assert.deepEqual(
    profile.limits,
    {
      cpuLimit: policy.native.cpuLimit,
      memory: policy.native.memory,
      pidsLimit: policy.native.pidsLimit,
      deadlineSeconds: policy.base.deadlineSeconds,
      logByteLimit: policy.native.logByteLimit,
      workByteLimit: policy.native.workByteLimit,
      inputFileByteLimit: policy.native.inputFileByteLimit,
    },
    "Frozen source-profile limits changed",
  );
  return policy;
}

export async function loadCProducerExecutionPolicy(id, profile) {
  if (id === undefined || id === null) return null;
  const pin = cProducerExecutionPolicyPin(id);
  const raw = await readFile(new URL(pin.file, import.meta.url));
  assert.ok(
    raw.length <= 16384,
    "Finite local execution policy metadata bound",
  );
  assert.equal(
    sha256(raw),
    pin.sha256,
    "Frozen local execution policy changed",
  );
  const policy = validateCProducerExecutionPolicy(JSON.parse(raw), profile);
  // The private loaded object cannot be changed through the returned plan.
  for (const value of [
    policy.base,
    policy.native.command,
    policy.native,
    policy.windows,
    policy.requires,
    policy,
  ])
    Object.freeze(value);
  return policy;
}

export function cProducerExecutionLimits(profile, policy = null) {
  if (policy === null) return profile.limits;
  validateCProducerExecutionPolicy(policy, profile);
  return Object.freeze({
    ...profile.limits,
    deadlineSeconds: policy.native.deadlineSeconds,
  });
}

export function cProducerExecutionPolicyBinding(policy, profile) {
  if (policy === null) return null;
  validateCProducerExecutionPolicy(policy, profile);
  return {
    schemaVersion: 1,
    id: policy.id,
    context: policy.context,
    sourcePin: { ...cProducerExecutionPolicyPin(policy.id) },
    executionLimits: cProducerExecutionLimits(profile, policy),
    windows: policy.windows,
  };
}

// One monotonic controller clock covers preparation, execution and recovery.
// No phase grants itself a fresh copy of the whole execution window.
export function cProducerExecutionClock(policy, profile, started) {
  validateCProducerExecutionPolicy(policy, profile);
  assert.ok(
    Number.isFinite(started) && started >= 0 && started <= performance.now(),
    "Invalid controller monotonic origin",
  );
  const windows = policy.windows;
  const deadline = started + windows.controllerTotalSeconds * 1000;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const elapsed = () => (performance.now() - started) / 1000;
  let nativeAdmission = null;
  return Object.freeze({
    remaining,
    setupRemaining() {
      const value = Math.floor(
        started + windows.controllerSetupSeconds * 1000 - performance.now(),
      );
      assert.ok(value > 0, "Local controller preparation allowance exhausted");
      return value;
    },
    admitNative() {
      assert.ok(
        nativeAdmission === null,
        "Original native execution admission is one-shot",
      );
      const reserve =
        windows.postStopCollectorObserverSeconds +
        windows.controllerFinalizationReserveSeconds;
      assert.ok(
        elapsed() <= windows.controllerSetupSeconds &&
          remaining() >= (windows.producerObserverSeconds + reserve) * 1000,
        "Insufficient original controller remainder for native execution and recovery",
      );
      nativeAdmission = Object.freeze({
        elapsedSeconds: elapsed(),
        observerSeconds: windows.producerObserverSeconds,
        recoveryReserveSeconds: reserve,
      });
      return nativeAdmission;
    },
    collectionTimeoutMs() {
      const value = Math.min(
        windows.postStopCollectorObserverSeconds * 1000,
        remaining() - windows.controllerFinalizationReserveSeconds * 1000,
      );
      assert.ok(value > 0, "Original controller recovery allowance exhausted");
      return Math.floor(value);
    },
    snapshot() {
      const now = performance.now();
      const elapsedMs = Math.ceil(now - started);
      return {
        schemaVersion: 1,
        scope: "same-controller-process-monotonic",
        totalSeconds: windows.controllerTotalSeconds,
        elapsedSeconds: elapsedMs / 1000,
        remainingMs: Math.max(
          0,
          windows.controllerTotalSeconds * 1000 - elapsedMs,
        ),
        nativeAdmission,
      };
    },
  });
}

export function validateCProducerExecutionClock(value, profile, policy) {
  validateCProducerExecutionPolicy(policy, profile);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      "schemaVersion",
      "scope",
      "totalSeconds",
      "elapsedSeconds",
      "remainingMs",
      "nativeAdmission",
    ].sort(),
  );
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.scope, "same-controller-process-monotonic");
  assert.equal(value.totalSeconds, policy.windows.controllerTotalSeconds);
  assert.ok(
    Number.isFinite(value.elapsedSeconds) &&
      value.elapsedSeconds >= 0 &&
      value.elapsedSeconds <= value.totalSeconds,
  );
  assert.equal(
    value.remainingMs,
    Math.max(
      0,
      Math.round(value.totalSeconds * 1000 - value.elapsedSeconds * 1000),
    ),
  );
  assert.ok(
    value.nativeAdmission &&
      Number.isFinite(value.nativeAdmission.elapsedSeconds) &&
      value.nativeAdmission.elapsedSeconds >= 0 &&
      value.nativeAdmission.elapsedSeconds <=
        policy.windows.controllerSetupSeconds,
  );
  assert.deepEqual(
    Object.keys(value.nativeAdmission).sort(),
    ["elapsedSeconds", "observerSeconds", "recoveryReserveSeconds"].sort(),
  );
  assert.equal(
    value.nativeAdmission.observerSeconds,
    policy.windows.producerObserverSeconds,
  );
  assert.equal(
    value.nativeAdmission.recoveryReserveSeconds,
    policy.windows.postStopCollectorObserverSeconds +
      policy.windows.controllerFinalizationReserveSeconds,
  );
  assert.ok(value.elapsedSeconds >= value.nativeAdmission.elapsedSeconds);
  return value;
}
