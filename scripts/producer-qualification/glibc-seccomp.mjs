// Operator-only carrier compatibility data. It is not an isolation guarantee.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identifyFile } from "../qualify-binutils-producer.mjs";
import { sha256 } from "./c-producer-profile.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const { structuredClone } = globalThis;
export const glibcSeccompMetadataSha256 =
  "1dd74d0956dd3a06837a43afd61c3b1150d3bfc43c9b7d6b40c3acb3e9f202ac";
export const glibcSeccompGeneratedFile = "glibc-native-seccomp.json";
export const glibcSeccompSourceFiles = [
  "glibc-seccomp.mjs",
  "glibc-seccomp.v1.json",
  "glibc-seccomp-probe.py",
  "moby-28.0.4/default.json",
  "moby-28.0.4/LICENSE",
  "moby-28.0.4/NOTICE",
  "moby-28.0.4/AUTHORS",
];
export const glibcSeccompAdditions = () => [
  {
    names: ["clock_settime"],
    action: "SCMP_ACT_ALLOW",
    args: [{ index: 0, value: 1, op: "SCMP_CMP_EQ" }],
  },
  {
    names: ["personality"],
    action: "SCMP_ACT_ALLOW",
    args: [{ index: 0, value: 4294967274, op: "SCMP_CMP_EQ" }],
  },
];

export function deriveGlibcSeccomp(base) {
  assert.equal(base.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(base.defaultErrnoRet, 1);
  assert.ok(Array.isArray(base.syscalls));
  return {
    ...structuredClone(base),
    syscalls: [...structuredClone(base.syscalls), ...glibcSeccompAdditions()],
  };
}

export function validateGlibcSeccompDelta(base, derived) {
  assert.deepEqual(
    derived,
    deriveGlibcSeccomp(base),
    "GLIBC policy must retain every default rule and add only two exact predicates",
  );
}

export async function loadGlibcSeccomp() {
  const file = path.join(directory, "glibc-seccomp.v1.json");
  const identity = await identifyFile(file, 65536);
  assert.equal(identity.sha256, glibcSeccompMetadataSha256);
  const metadata = JSON.parse(await readFile(file, "utf8"));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(
    metadata.upstream.sourceCommit,
    "6430e49a55babd9b8f4d08e70ecb2b68900770fe",
  );
  assert.deepEqual(metadata.additions, glibcSeccompAdditions());
  for (const row of metadata.inputs)
    assert.deepEqual(await identifyFile(path.join(directory, row.file)), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  const base = JSON.parse(
    await readFile(path.join(directory, "moby-28.0.4/default.json"), "utf8"),
  );
  const policy = deriveGlibcSeccomp(base);
  validateGlibcSeccompDelta(base, policy);
  const bytes = Buffer.from(JSON.stringify(policy, null, 2) + "\n");
  return {
    metadata,
    policy,
    bytes,
    generated: {
      file: glibcSeccompGeneratedFile,
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
}

export function validateGlibcDockerMetadata(version, info) {
  const server = version.Server;
  assert.equal(server.Version, "28.0.4", "Unqualified Docker server version");
  const commits = ["6430e49", "6430e49a55babd9b8f4d08e70ecb2b68900770fe"];
  assert.ok(commits.includes(server.GitCommit), "Unqualified Docker build");
  assert.equal(server.Os, "linux");
  assert.equal(server.Arch, "amd64");
  const engines = server.Components.filter((row) => row.Name === "Engine");
  assert.equal(engines.length, 1);
  assert.equal(engines[0].Version, server.Version);
  assert.ok(commits.includes(engines[0].Details.GitCommit));
  assert.equal(info.ServerVersion, server.Version);
  assert.equal(info.OSType, "linux");
  assert.match(info.Architecture, /^(amd64|x86_64)$/u);
  assert.deepEqual(
    info.SecurityOptions.filter((row) => row.startsWith("name=seccomp")),
    ["name=seccomp,profile=builtin"],
    "Unknown default seccomp profile",
  );
  return {
    serverVersion: server.Version,
    serverGitCommit: server.GitCommit,
    sourceCommit: "6430e49a55babd9b8f4d08e70ecb2b68900770fe",
    platform: "linux/amd64",
    defaultProfile: "builtin",
    reportedMetadataOnly: true,
    defaultProfileBytesIndependentlyAttestedFromDaemon: false,
    historicalPublisherConsumptionVerified: false,
  };
}

export function validateGlibcDockerSecurityOptions(value, mode, policy) {
  assert.ok(["baseline", "derived"].includes(mode));
  assert.deepEqual(
    value ?? [],
    mode === "derived" ? ["seccomp=" + JSON.stringify(policy)] : [],
    "Docker must retain exactly the client-loaded generated seccomp policy",
  );
  return true;
}

export function validateGlibcSyscallProbe(value, mode) {
  assert.ok(["baseline", "derived"].includes(mode));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.machine, "x86_64");
  assert.equal(value.mode, mode);
  for (const field of ["effective", "permitted", "bounding"]) {
    assert.match(value.capabilities[field], /^[a-f0-9]{16}$/u);
    const bits = BigInt("0x" + value.capabilities[field]);
    assert.equal(bits & ((1n << 25n) | (1n << 21n)), 0n);
  }
  const sentinel = 0xdefaced;
  const saved = value.personality.saved.result;
  assert.ok(Number.isInteger(saved) && saved !== -1);
  assert.equal(value.personality.saved.errno, sentinel);
  assert.deepEqual(value.personality.near, { result: -1, errno: 1 });
  assert.deepEqual(value.personality.linuxQuery, {
    result: 0,
    errno: sentinel,
  });
  if (mode === "baseline") {
    assert.deepEqual(value.personality.negativeSet, { result: -1, errno: 1 });
    assert.deepEqual(value.personality.negativeQuery, {
      result: saved,
      errno: sentinel,
    });
    assert.deepEqual(value.personality.linuxSet, {
      result: saved,
      errno: sentinel,
    });
    assert.deepEqual(value.clock.monotonicSet, { result: -1, errno: 1 });
  } else {
    assert.deepEqual(value.personality.negativeSet, {
      result: saved,
      errno: sentinel,
    });
    assert.deepEqual(value.personality.negativeQuery, {
      result: -22,
      errno: sentinel,
    });
    assert.deepEqual(value.personality.linuxSet, {
      result: -22,
      errno: sentinel,
    });
    assert.deepEqual(value.clock.monotonicSet, { result: -1, errno: 22 });
  }
  assert.deepEqual(value.clock.realtimeInvalidSet, { result: -1, errno: 1 });
  assert.equal(value.clock.monotonicRead, 0);
  assert.equal(value.restored, true);
  assert.equal(value.projectOrCompilerExecuted, false);
  assert.equal(value.clockChangeAttemptedWithValidRealtimeArgument, false);
  return { mode, exactPredicatesObserved: true, originalBodyInvoked: false };
}

// Pure receipt checks complement, rather than replace, the physical raw-log checks.
export function validateGlibcSyscallPreflight(
  receipt,
  policy,
  observedTerminal,
) {
  const proof = receipt.syscallPreflight;
  assert.equal(proof.schemaVersion, 1);
  assert.equal(
    proof.state,
    "exact-kernel-predicates-observed-original-body-not-invoked",
  );
  assert.deepEqual(proof.policy, policy.generated);
  assert.deepEqual(receipt.generatedControlPins, [policy.generated]);
  assert.deepEqual(Object.keys(proof.modes).sort(), ["baseline", "derived"]);
  for (const mode of ["baseline", "derived"]) {
    const row = proof.modes[mode];
    assert.ok(observedTerminal(row.observer) && row.observer.exitCode === 0);
    assert.ok(row.log.bytes > 0 && row.log.bytes <= 65536);
    assert.equal(row.observer.retainedBytes, row.log.bytes);
    assert.match(row.log.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(["removed", "absent"].includes(row.cleanup.state));
    assert.deepEqual(
      row.predicates,
      validateGlibcSyscallProbe(row.record, mode),
    );
    assert.equal(row.imageId, receipt.image.id);
  }
  assert.deepEqual(
    proof.modes.baseline.record.capabilities,
    proof.modes.derived.record.capabilities,
  );
  for (const key of [
    "originalBodyInvoked",
    "fullCompilerSdkBootstrapClosureVerified",
    "historicalPublisherConsumptionVerified",
    "gateAComplete",
  ])
    assert.equal(proof[key], false);
  const selected = receipt.syscallRuntime;
  assert.equal(selected.serverVersion, "28.0.4");
  assert.ok(
    ["6430e49", "6430e49a55babd9b8f4d08e70ecb2b68900770fe"].includes(
      selected.serverGitCommit,
    ),
  );
  assert.deepEqual(selected, {
    serverVersion: "28.0.4",
    serverGitCommit: selected.serverGitCommit,
    sourceCommit: "6430e49a55babd9b8f4d08e70ecb2b68900770fe",
    platform: "linux/amd64",
    defaultProfile: "builtin",
    reportedMetadataOnly: true,
    defaultProfileBytesIndependentlyAttestedFromDaemon: false,
    historicalPublisherConsumptionVerified: false,
  });
  return proof;
}
