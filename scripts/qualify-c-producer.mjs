// Explicit operator-only development qualification. CLI/MCP discovery never calls it.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import {
  atomicReceipt,
  caseSensitiveParent,
  cleanupContainer,
  copyPinnedInput,
  identifyFile,
  observeForeground,
  physicalPath,
  validateDestination,
  validateInputs,
} from "./qualify-binutils-producer.mjs";
import {
  registryImageIdentity,
  validateObservedImage,
} from "./producer-qualification/binutils-image-identity.mjs";
import {
  reconcileRetentionLog,
  startRetentionObserver,
} from "./producer-qualification/binutils-retention-observer.mjs";
import {
  cProducerDirectory,
  loadCProducerProfile,
  safeRelative,
  sha256,
} from "./producer-qualification/c-producer-profile.mjs";
import {
  glibcSeccompGeneratedFile,
  glibcSeccompSourceFiles,
  loadGlibcSeccomp,
  validateGlibcDockerMetadata,
  validateGlibcSyscallProbe,
  validateGlibcDockerSecurityOptions,
} from "./producer-qualification/glibc-seccomp.mjs";

const { AbortController } = globalThis;
const exec = promisify(execFile);
const environment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};
const docker = (args) =>
  exec("docker", args, { env: environment, timeout: 15000, maxBuffer: 65536 });
const self = fileURLToPath(import.meta.url);
const sourceFiles = [
  "c-producer-profiles.v1.json",
  "c-producer-profile.mjs",
  "c-producer-build.sh",
  "c-producer-test-reports.py",
  "binutils-retention-observer.py",
  "binutils-retention-observer.mjs",
  "binutils-image-identity.mjs",
  "binutils-image-identity.v1.json",
  "glibc-seccomp.mjs",
];
const controlFiles = [
  "c-producer-build.sh",
  "c-producer-test-reports.py",
  "binutils-retention-observer.py",
];
export const cProducerSourceFiles = (profile) => [
  ...sourceFiles,
  ...(profile.sourcePackage === "glibc"
    ? glibcSeccompSourceFiles.filter((file) => file !== "glibc-seccomp.mjs")
    : []),
];

export function validateCProducerCallerIdentity(uid, gid) {
  for (const value of [uid, gid])
    assert.ok(
      Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 4294967294 &&
        !Object.is(value, -0),
      "Malformed captured caller UID/GID",
    );
  return Object.freeze({ uid, gid });
}
export function captureCProducerCallerIdentity() {
  assert.ok(
    typeof process.getuid === "function" &&
      typeof process.getgid === "function" &&
      typeof process.geteuid === "function" &&
      typeof process.getegid === "function",
    "POSIX caller identity is unavailable",
  );
  const caller = validateCProducerCallerIdentity(
    process.getuid(),
    process.getgid(),
  );
  assert.equal(
    process.geteuid(),
    caller.uid,
    "Different real/effective caller identity is unqualified",
  );
  assert.equal(
    process.getegid(),
    caller.gid,
    "Different real/effective caller identity is unqualified",
  );
  return caller;
}
function verifyCopyOwner(info, caller, mode) {
  assert.equal(
    info.uid,
    BigInt(caller.uid),
    "Copied export owner differs from captured caller",
  );
  assert.equal(
    info.gid,
    BigInt(caller.gid),
    "Copied export group differs from captured caller",
  );
  assert.equal(
    info.mode & 0o7777n,
    BigInt(mode),
    "Copied export mode differs from private custody mode",
  );
}
export async function boundedCProducerBytes(
  file,
  maximum,
  expectedCaller = null,
) {
  assert.ok(
    Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 64 * 1024 ** 2,
    "Finite result read bound refused",
  );
  await physicalPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size <= BigInt(maximum),
      "Physical result exceeds read bound",
    );
    if (expectedCaller)
      verifyCopyOwner(
        before,
        validateCProducerCallerIdentity(expectedCaller.uid, expectedCaller.gid),
        0o600,
      );
    const raw = Buffer.alloc(maximum + 1);
    let bytes = 0;
    while (bytes < raw.length) {
      const next = await handle.read(raw, bytes, raw.length - bytes, null);
      if (next.bytesRead === 0) break;
      bytes += next.bytesRead;
    }
    assert.ok(bytes <= maximum, "Physical result grew beyond read bound");
    const after = await handle.stat({ bigint: true });
    const final = await lstat(file, { bigint: true });
    const identity = (value) => [
      value.dev,
      value.ino,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ];
    assert.ok(final.isFile() && !final.isSymbolicLink());
    if (expectedCaller) {
      verifyCopyOwner(after, expectedCaller, 0o600);
      verifyCopyOwner(final, expectedCaller, 0o600);
    }
    assert.deepEqual(
      identity(before),
      identity(after),
      "Physical result changed while read",
    );
    assert.deepEqual(
      identity(after),
      identity(final),
      "Physical result path changed while read",
    );
    assert.equal(BigInt(bytes), after.size);
    return raw.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}
async function checkedJson(file, maximum) {
  return JSON.parse(await boundedCProducerBytes(file, maximum));
}
export async function readCProducerCopyManifest(file, caller) {
  validateCProducerCallerIdentity(caller.uid, caller.gid);
  return JSON.parse(await boundedCProducerBytes(file, 8 * 1024 ** 2, caller));
}

export function observedCProducerTerminal(result) {
  return (
    result !== null &&
    typeof result === "object" &&
    Object.keys(result).sort().join(",") ===
      "error,exitCode,reason,retainedBytes,signal,stopError" &&
    Number.isSafeInteger(result.retainedBytes) &&
    result.retainedBytes >= 0 &&
    result.retainedBytes <= 512 * 1024 ** 2 &&
    Number.isSafeInteger(result.exitCode) &&
    result.exitCode >= 0 &&
    result.exitCode <= 255 &&
    result.signal === null &&
    result.error === null &&
    result.reason === null &&
    result.stopError === null
  );
}
export function cProducerCompletion(command, result, outputs, reports) {
  assert.equal(command.schemaVersion, 1);
  assert.deepEqual(command.command, [
    "dpkg-buildpackage",
    "-b",
    "-us",
    "-uc",
    "--jobs=4",
  ]);
  assert.equal(typeof command.invoked, "boolean");
  assert.ok(
    command.exitCode === null ||
      (Number.isSafeInteger(command.exitCode) &&
        command.exitCode >= 0 &&
        command.exitCode <= 255),
  );
  assert.ok(
    Number.isSafeInteger(command.wrapperExitCode) &&
      command.wrapperExitCode >= 0 &&
      command.wrapperExitCode <= 255,
  );
  const positiveCount = (row, key) =>
    Number.isSafeInteger(row.counts[key]) && row.counts[key] > 0;
  const executedOutcomes = reports.reports.some((row) =>
    ["PASS", "FAIL", "XFAIL", "XPASS"].some((key) => positiveCount(row, key)),
  );
  const testEvidenceState = !executedOutcomes
    ? "unavailable"
    : reports.reports.some((row) =>
          ["FAIL", "XPASS", "ERROR", "UNRESOLVED"].some((key) =>
            positiveCount(row, key),
          ),
        )
      ? "failed"
      : "reported";
  const complete =
    command.invoked &&
    command.exitCode === 0 &&
    command.wrapperExitCode === 0 &&
    observedCProducerTerminal(result) &&
    result.exitCode === 0 &&
    outputs.some(
      (row) =>
        /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb)$/u.test(row.file) &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes > 0,
    ) &&
    executedOutcomes;
  return {
    originalCommandCompleted: complete,
    testEvidenceState,
    state: complete
      ? "original-command-completed-qualification-incomplete"
      : command.invoked && command.exitCode !== null
        ? "original-command-failed-or-incomplete"
        : "original-command-terminal-unobserved",
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
}

export function cProducerArguments(
  catalog,
  profile,
  destination,
  attempt,
  caller,
) {
  caller = validateCProducerCallerIdentity(caller.uid, caller.gid);
  assert.match(attempt, /^[a-f0-9-]{36}$/u);
  assert.equal(path.resolve(destination), destination);
  assert.ok(!/[\r\n,]/u.test(destination), "Ambiguous Docker bind path");
  const mount = (file, target, readonly) => [
    "--mount",
    `type=bind,src=${path.join(destination, "bundle", file)},target=${target}${readonly ? ",readonly" : ""}`,
  ];
  return [
    "run",
    "--rm",
    "--init",
    "--pull=never",
    "--platform",
    catalog.platform,
    "--user",
    "0:0",
    "--cidfile",
    path.join(destination, "container.id"),
    "--name",
    "checktrail-producer-" + attempt,
    "--network",
    "none",
    "--cpus",
    String(profile.limits.cpuLimit),
    "--memory",
    profile.limits.memory,
    "--pids-limit",
    String(profile.limits.pidsLimit),
    "--label",
    "io.checktrail.producer-attempt=" + attempt,
    ...(profile.sourcePackage === "glibc"
      ? [
          "--security-opt",
          "seccomp=" +
            path.join(destination, "controls", glibcSeccompGeneratedFile),
        ]
      : []),
    "--entrypoint",
    "/usr/bin/env",
    ...mount("source", "/inputs", true),
    ...mount("apt-lists", "/var/lib/apt/lists", false),
    ...mount("apt-archives", "/var/cache/apt/archives", false),
    ...mount(
      "keyrings/debian-keyring.gpg",
      "/usr/share/keyrings/debian-keyring.gpg",
      true,
    ),
    "--mount",
    `type=bind,src=${path.join(destination, "work")},target=/work`,
    "--mount",
    `type=bind,src=${path.join(destination, "controls")},target=/controller,readonly`,
    "--workdir",
    "/work",
    catalog.image,
    "-i",
    ...Object.entries(catalog.environment).map(
      ([key, value]) => key + "=" + value,
    ),
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=30s",
    String(profile.limits.deadlineSeconds),
    "/bin/sh",
    "/controller/c-producer-build.sh",
    profile.sourcePackage,
    String(caller.uid),
    String(caller.gid),
  ];
}

export async function verifyCProducerReports(value, root, profile, caller) {
  caller = validateCProducerCallerIdentity(caller.uid, caller.gid);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profile, profile.sourcePackage);
  assert.deepEqual(value.generatedBuildRoots, profile.generatedBuildRoots);
  for (const key of [
    "completeConfigurationInventoryAssessed",
    "duplicateReportsAreIndependentEvidence",
    "allOriginalTestsPassRequired",
    "fullCompilerSdkBootstrapClosureVerified",
    "gateAComplete",
  ])
    assert.equal(value[key], false);
  assert.ok(Array.isArray(value.reports) && value.reports.length <= 8192);
  assert.ok(
    Array.isArray(value.skippedLinkedDirectories) &&
      value.skippedLinkedDirectories.length <= 8192,
  );
  const custody = value.exportCustody;
  assert.equal(custody.schemaVersion, 1);
  assert.deepEqual(
    custody.requestedCaller,
    caller,
    "Producer copy custody names a different caller",
  );
  assert.ok(
    Number.isSafeInteger(custody.producerEffectiveUid) &&
      custody.producerEffectiveUid >= 0 &&
      custody.producerEffectiveUid <= 4294967294,
  );
  assert.equal(custody.newCopyOwnersVerified, true);
  for (const key of [
    "recursiveOwnershipChangeUsed",
    "sourceTreePermissionsChanged",
    "nativeLinuxCrossUidAcceptanceVerified",
  ])
    assert.equal(custody[key], false);
  assert.ok(
    Array.isArray(custody.directories) &&
      custody.directories.length <= 50000 &&
      Array.isArray(custody.files) &&
      custody.files.length <= 16384,
  );
  const directories = new Set();
  const claimedFiles = new Set();
  const producerOwner = (row, mode) => {
    assert.equal(row.uid, caller.uid);
    assert.equal(row.gid, caller.gid);
    assert.equal(row.mode, mode);
    for (const key of ["producerDevice", "producerInode"])
      assert.match(row[key], /^[0-9]{1,32}$/u);
  };
  for (const row of custody.directories) {
    assert.ok(
      (row.directory === "." || safeRelative(row.directory)) &&
        !directories.has(row.directory),
      "Invalid or duplicate export directory custody",
    );
    directories.add(row.directory);
    producerOwner(row.ownership, 0o700);
    const directory = path.join(root, row.directory);
    await physicalPath(directory, true);
    verifyCopyOwner(await lstat(directory, { bigint: true }), caller, 0o700);
  }
  assert.ok(directories.has("."), "Copied export root custody is missing");
  for (const row of custody.files) {
    assert.ok(
      safeRelative(row.file) && !claimedFiles.has(row.file),
      "Invalid or duplicate export file custody",
    );
    claimedFiles.add(row.file);
    producerOwner(row.ownership, 0o600);
  }
  let retainedBytes = 0;
  const names = new Set();
  const keys = [
    "PASS",
    "FAIL",
    "XFAIL",
    "XPASS",
    "UNSUPPORTED",
    "UNRESOLVED",
    "UNTESTED",
    "ERROR",
    "SKIP",
  ];
  const verify = async (row) => {
    assert.ok(
      safeRelative(row.file) &&
        profile.generatedBuildRoots.includes(row.file.split("/")[0]) &&
        !names.has(row.file),
      "Foreign or duplicate original report/log",
    );
    names.add(row.file);
    assert.ok(
      claimedFiles.has(row.file),
      "Original report file custody is missing",
    );
    const parts = row.file.split("/");
    for (let count = 1; count < parts.length; count++)
      assert.ok(
        directories.has(parts.slice(0, count).join("/")),
        "Original report ancestor custody is missing",
      );
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        row.bytes <= profile.reportFileByteLimit,
    );
    retainedBytes += row.bytes;
    assert.ok(retainedBytes <= profile.reportAggregateByteLimit);
    const file = path.join(root, row.file);
    assert.deepEqual(await identifyFile(file, profile.reportFileByteLimit), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
    const raw = await boundedCProducerBytes(
      file,
      profile.reportFileByteLimit,
      caller,
    );
    assert.equal(
      sha256(raw),
      row.sha256,
      "Retained report changed after observation",
    );
    return raw;
  };
  for (const row of value.reports) {
    const raw = await verify(row);
    assert.equal(row.configuration, row.file.split("/")[0]);
    assert.ok(["original-sum", "original-trs"].includes(row.format));
    assert.ok(
      row.file.endsWith(row.format === "original-sum" ? ".sum" : ".trs"),
    );
    const lines = raw.length ? raw.toString("latin1").split(/\r\n|\n|\r/u) : [];
    if (raw.length && /[\r\n]$/u.test(raw.toString("latin1"))) lines.pop();
    const counts = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const line of lines) {
      const match =
        /^(PASS|FAIL|XFAIL|XPASS|UNSUPPORTED|UNRESOLVED|UNTESTED|ERROR|SKIP):(?:[ \t\f\v]|$)/u.exec(
          line,
        );
      if (match) counts[match[1]]++;
    }
    assert.deepEqual(
      row.counts,
      counts,
      "Original outcome counts do not match physical bytes",
    );
    assert.equal(row.totalLines, lines.length);
    assert.equal(
      row.otherLines,
      lines.length - Object.values(counts).reduce((sum, n) => sum + n, 0),
    );
    if (row.format === "original-trs")
      assert.equal(row.outcomesInterpreted, false);
    if (row.log) await verify(row.log);
  }
  assert.equal(
    value.retainedBytes,
    retainedBytes,
    "Original report aggregate differs",
  );
  assert.equal(
    claimedFiles.size,
    names.size,
    "Export file custody inventory differs from actual reports",
  );
  return {
    ...value,
    physicalBytesReconciled: true,
    completeConfigurationInventoryAssessed: false,
    hostCopyCustody: {
      capturedCaller: caller,
      directoriesObserved: directories.size,
      filesObserved: names.size,
      actualOwnerModesVerified: true,
      producerInodesRelabeledAsHostIdentity: false,
      nativeLinuxCrossUidAcceptanceVerified: false,
    },
  };
}

async function outputFiles(work, maximum) {
  const root = await physicalPath(path.join(work, "output"), true);
  const names = await readdir(root);
  assert.ok(names.length <= 1024);
  const rows = [];
  for (const file of names.sort()) {
    assert.match(
      file,
      /^[A-Za-z0-9][A-Za-z0-9.+_~-]*\.(deb|udeb|changes|buildinfo)$/u,
    );
    rows.push({
      file,
      ...(await identifyFile(path.join(root, file), maximum)),
    });
  }
  return rows;
}

export async function prepareCProducer(name, inputs, output) {
  const selected = await loadCProducerProfile(name);
  await validateInputs(inputs, selected.profile.files);
  const { destination, parent } = await validateDestination(inputs, output);
  const sources = [];
  for (const file of cProducerSourceFiles(selected.profile))
    sources.push({
      file,
      ...(await identifyFile(
        path.join(cProducerDirectory, file),
        2 * 1024 ** 2,
      )),
    });
  const harness = [
    {
      file: "qualify-c-producer.mjs",
      ...(await identifyFile(self, 2 * 1024 ** 2)),
    },
    {
      file: "qualify-binutils-producer.mjs",
      ...(await identifyFile(
        fileURLToPath(
          new URL("qualify-binutils-producer.mjs", import.meta.url),
        ),
        2 * 1024 ** 2,
      )),
    },
  ];
  const imageIdentity = registryImageIdentity(
    await checkedJson(
      path.join(cProducerDirectory, "binutils-image-identity.v1.json"),
      1024 ** 2,
    ),
    selected.catalog.image,
  );
  return {
    ...selected,
    inputs,
    destination,
    parent,
    sources,
    harness,
    imageIdentity,
    syscallPolicy:
      selected.profile.sourcePackage === "glibc"
        ? await loadGlibcSeccomp()
        : null,
    buildExecuted: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
  };
}

export function cProducerSyscallPreflightArguments(
  catalog,
  destination,
  attempt,
  mode,
) {
  assert.ok(["baseline", "derived"].includes(mode));
  assert.match(attempt, /^[a-f0-9-]{36}$/u);
  assert.equal(path.resolve(destination), destination);
  assert.ok(!/[\r\n,]/u.test(destination));
  return [
    "run",
    "--init",
    "--pull=never",
    "--platform",
    catalog.platform,
    "--user",
    "0:0",
    "--cidfile",
    path.join(destination, "seccomp-" + mode + ".id"),
    "--name",
    "checktrail-producer-" + attempt,
    "--network",
    "none",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "--pids-limit",
    "32",
    "--read-only",
    "--label",
    "io.checktrail.producer-attempt=" + attempt,
    ...(mode === "derived"
      ? [
          "--security-opt",
          "seccomp=" +
            path.join(destination, "controls", glibcSeccompGeneratedFile),
        ]
      : []),
    "--mount",
    `type=bind,src=${path.join(destination, "controls")},target=/controller,readonly`,
    "--entrypoint",
    "/usr/bin/python3",
    catalog.image,
    "-I",
    "-S",
    "-B",
    "/controller/glibc-seccomp-probe.py",
    mode,
  ];
}

async function verifySyscallPreflight(plan, signal, state) {
  const proof = {
    schemaVersion: 1,
    state: "preparing-original-compiler-body-refused",
    policy: plan.syscallPolicy.generated,
    modes: {},
    originalBodyInvoked: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  state.syscallPreflight = proof;
  for (const mode of ["baseline", "derived"]) {
    const attempt = randomUUID();
    const cid = path.join(plan.destination, "seccomp-" + mode + ".id");
    const log = path.join(plan.destination, "seccomp-" + mode + ".log");
    const row = { attempt, cleanup: { state: "pending" } };
    proof.modes[mode] = row;
    const errors = [];
    try {
      row.observer = await observeForeground(
        () =>
          spawn(
            "docker",
            cProducerSyscallPreflightArguments(
              plan.catalog,
              plan.destination,
              attempt,
              mode,
            ),
            {
              env: environment,
              stdio: ["ignore", "pipe", "pipe"],
            },
          ),
        log,
        {
          timeoutMs: 30000,
          maxBytes: 65536,
          signal,
          stop: () => cleanupContainer(cid, attempt),
        },
      );
      assert.ok(
        observedCProducerTerminal(row.observer) && row.observer.exitCode === 0,
        "GLIBC syscall carrier probe did not complete",
      );
      row.record = await checkedJson(log, 65536);
      row.predicates = validateGlibcSyscallProbe(row.record, mode);
      const id = (await boundedCProducerBytes(cid, 1024))
        .toString("utf8")
        .trim();
      assert.match(id, /^[a-f0-9]{64}$/u);
      const inspected = JSON.parse((await docker(["inspect", id])).stdout)[0];
      assert.equal(inspected.Image, state.image.id);
      row.imageId = inspected.Image;
      assert.equal(
        inspected.Config.Labels["io.checktrail.producer-attempt"],
        attempt,
      );
      assert.equal(inspected.HostConfig.NetworkMode, "none");
      assert.deepEqual(inspected.HostConfig.CapAdd ?? [], []);
      assert.deepEqual(inspected.HostConfig.CapDrop ?? [], []);
      assert.equal(inspected.HostConfig.Privileged, false);
      validateGlibcDockerSecurityOptions(
        inspected.HostConfig.SecurityOpt,
        mode,
        plan.syscallPolicy.policy,
      );
      row.log = await identifyFile(log, 65536);
      assert.equal(row.log.bytes, row.observer.retainedBytes);
    } catch (error) {
      errors.push(error);
      proof.state = "failed-original-compiler-body-refused";
    } finally {
      try {
        row.cleanup = await cleanupContainer(cid, attempt);
      } catch (error) {
        row.cleanup = { state: "unavailable", error: String(error) };
        proof.state = "cleanup-failed-original-compiler-body-refused";
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Syscall preflight and cleanup failed", {
        cause: errors.at(-1),
      });
  }
  assert.deepEqual(
    proof.modes.baseline.record.capabilities,
    proof.modes.derived.record.capabilities,
    "Derived GLIBC policy changed observed default capabilities",
  );
  proof.state = "exact-kernel-predicates-observed-original-body-not-invoked";
  return proof;
}

export function cProducerCustodyPreflightArguments(
  catalog,
  destination,
  attempt,
  caller,
) {
  caller = validateCProducerCallerIdentity(caller.uid, caller.gid);
  assert.match(attempt, /^[a-f0-9-]{36}$/u);
  assert.equal(path.resolve(destination), destination);
  assert.ok(!/[\r\n,]/u.test(destination));
  return [
    "run",
    "--rm",
    "--init",
    "--pull=never",
    "--platform",
    catalog.platform,
    "--user",
    "0:0",
    "--read-only",
    "--cap-drop=ALL",
    "--cap-add=CHOWN",
    "--cap-add=DAC_OVERRIDE",
    "--security-opt=no-new-privileges",
    "--network",
    "none",
    "--cpus",
    "0.25",
    "--memory",
    "128m",
    "--pids-limit",
    "16",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=4m",
    "--cidfile",
    path.join(destination, "custody-preflight.container.id"),
    "--name",
    "checktrail-producer-" + attempt,
    "--label",
    "io.checktrail.producer-attempt=" + attempt,
    "--mount",
    `type=bind,src=${path.join(destination, "custody-preflight")},target=/custody`,
    "--mount",
    `type=bind,src=${path.join(destination, "controls")},target=/controller,readonly`,
    "--entrypoint",
    "/usr/bin/python3",
    "--workdir",
    "/",
    catalog.image,
    "-I",
    "-S",
    "-B",
    "/controller/c-producer-test-reports.py",
    "--custody-preflight",
    "/custody",
    String(caller.uid),
    String(caller.gid),
  ];
}

async function verifyCustodyPreflight(plan, caller, signal, state) {
  const attempt = randomUUID();
  const root = path.join(plan.destination, "custody-preflight");
  const cid = path.join(plan.destination, "custody-preflight.container.id");
  await mkdir(root, { mode: 0o700 });
  const proof = {
    state: "starting-fixed-synthetic-export",
    capturedCaller: caller,
    attempt,
    sourceOrCompilerInvoked: false,
    nativeLinuxCrossUidAcceptanceVerified: false,
    cleanup: { state: "pending" },
  };
  state.custodyPreflight = proof;
  await atomicReceipt(plan.destination, state);
  let originalError, cleanupFailure;
  try {
    const argv = cProducerCustodyPreflightArguments(
      plan.catalog,
      plan.destination,
      attempt,
      caller,
    );
    proof.observer = await observeForeground(
      () =>
        spawn("docker", argv, {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      path.join(plan.destination, "custody-preflight.log"),
      {
        timeoutMs: 30000,
        maxBytes: 65536,
        signal,
        stop: () => cleanupContainer(cid, attempt),
      },
    );
    assert.ok(
      observedCProducerTerminal(proof.observer) &&
        proof.observer.exitCode === 0,
      "Fixed caller-custody preflight did not complete; original compiler body refused",
    );
    const profile = (await loadCProducerProfile("glibc")).profile;
    const manifest = await readCProducerCopyManifest(
      path.join(root, "test-reports.json"),
      caller,
    );
    const evidence = await verifyCProducerReports(
      manifest,
      path.join(root, "original-test-reports"),
      profile,
      caller,
    );
    assert.equal(
      evidence.exportCustody.producerEffectiveUid,
      0,
      "Preflight did not observe actual container root producer",
    );
    assert.equal(evidence.reports.length, 1);
    assert.equal(evidence.reports[0].file, "build-tree/amd64-libc/tests.sum");
    assert.equal(evidence.reports[0].counts.PASS, 1);
    assert.equal(
      (
        await boundedCProducerBytes(
          path.join(
            root,
            "original-test-reports/build-tree/amd64-libc/tests.sum",
          ),
          1024,
          caller,
        )
      ).toString("utf8"),
      "PASS: synthetic custody preflight\n",
    );
    assert.equal(
      (
        await boundedCProducerBytes(
          path.join(
            root,
            "original-test-reports/build-tree/amd64-libc/tests.log",
          ),
          1024,
          caller,
        )
      ).toString("utf8"),
      "Original synthetic custody bytes\n",
    );
    proof.hostCopyCustody = evidence.hostCopyCustody;
    proof.manifest = await identifyFile(
      path.join(root, "test-reports.json"),
      65536,
    );
    proof.log = await identifyFile(
      path.join(plan.destination, "custody-preflight.log"),
      65536,
    );
    proof.state =
      caller.uid === 0
        ? "selected-root-caller-export-verified-no-cross-uid-claim"
        : "selected-nonroot-caller-export-verified";
    proof.nativeLinuxCrossUidAcceptanceVerified = caller.uid !== 0;
  } catch (error) {
    proof.state = "failed-original-compiler-body-refused";
    proof.error = String(error).slice(0, 2000);
    originalError = error;
  } finally {
    try {
      proof.cleanup = await cleanupContainer(cid, attempt);
    } catch (cleanupError) {
      proof.cleanup = { state: "unavailable", error: String(cleanupError) };
      proof.state = "cleanup-failed-original-compiler-body-refused";
      cleanupFailure = cleanupError;
    }
  }
  if (cleanupFailure) {
    if (originalError)
      throw new AggregateError(
        [originalError, cleanupFailure],
        "Custody preflight and cleanup failed",
        { cause: originalError },
      );
    throw cleanupFailure;
  }
  if (originalError) throw originalError;
  return proof;
}

async function run(plan) {
  const { catalog, profile, destination, inputs } = plan;
  assert.equal(
    process.platform,
    "linux",
    "Original qualification requires an actual Linux Node host",
  );
  const caller = captureCProducerCallerIdentity();
  assert.equal(process.arch, "x64");
  assert.equal(
    os.machine(),
    "x86_64",
    "Original qualification requires observed x86_64 kernel",
  );
  await caseSensitiveParent(plan.parent);
  const capacity = await statfs(plan.parent, { bigint: true });
  const inputBytes = profile.files.reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(
    capacity.bavail * capacity.bsize >=
      BigInt(
        profile.limits.workByteLimit + profile.limits.logByteLimit + inputBytes,
      ),
    "Insufficient retention filesystem capacity",
  );
  const daemon = JSON.parse(
    (await docker(["info", "--format", "{{json .}}"])).stdout,
  );
  assert.equal(daemon.OSType, "linux");
  assert.match(daemon.Architecture, /^(x86_64|amd64)$/u);
  const syscallRuntime = plan.syscallPolicy
    ? validateGlibcDockerMetadata(
        JSON.parse(
          (await docker(["version", "--format", "{{json .}}"])).stdout,
        ),
        daemon,
      )
    : null;
  const image = async () =>
    validateObservedImage(
      JSON.parse((await docker(["image", "inspect", catalog.image])).stdout)[0],
      plan.imageIdentity,
    );
  const initialImage = await image();
  await mkdir(destination, { mode: 0o700 });
  const attempt = randomUUID();
  const work = path.join(destination, "work"),
    bundle = path.join(destination, "bundle"),
    controls = path.join(destination, "controls");
  const controller = new AbortController();
  const abort = () => controller.abort("caller-signal");
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const state = {
    schemaVersion: 1,
    profile: profile.profile,
    sourceVersion: profile.sourceVersion,
    catalogSha256: plan.catalogSha256,
    sourcePins: plan.sources,
    harnessPins: plan.harness,
    image: initialImage,
    syscallRuntime,
    limits: profile.limits,
    attempt,
    state: "preparing",
    buildExecuted: false,
    startedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      kernelMachine: os.machine(),
      node: process.version,
      capturedCaller: caller,
      hardwareHostAttestationPerformed: false,
    },
    nativeFilesystemQuotaEnforced: false,
    originalBuildChecksDisabled: false,
    originalDefaultTargetsDisabled: false,
    inputAuthenticationAndFreshnessDisabled: false,
    originalBuild: { invoked: null, exitCode: null },
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  let observer, measuring, timer;
  const cid = path.join(destination, "container.id");
  const observerCid = path.join(destination, "retention-observer.id");
  const stop = () => cleanupContainer(cid, attempt);
  try {
    await atomicReceipt(destination, state);
    await mkdir(work, { mode: 0o700 });
    await mkdir(path.join(work, "home"), { mode: 0o700 });
    await mkdir(controls, { mode: 0o700 });
    for (const row of profile.files) {
      assert.ok(!controller.signal.aborted);
      const target = path.join(bundle, row.file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyPinnedInput(path.join(inputs, row.file), target, row);
    }
    const selectedControls = plan.sources.filter(
      (row) =>
        controlFiles.includes(row.file) ||
        (plan.syscallPolicy && row.file === "glibc-seccomp-probe.py"),
    );
    for (const row of selectedControls)
      await copyPinnedInput(
        path.join(cProducerDirectory, row.file),
        path.join(controls, row.file),
        row,
      );
    if (plan.syscallPolicy) {
      await writeFile(
        path.join(controls, glibcSeccompGeneratedFile),
        plan.syscallPolicy.bytes,
        { flag: "wx", mode: 0o600 },
      );
      selectedControls.push(plan.syscallPolicy.generated);
      state.generatedControlPins = [plan.syscallPolicy.generated];
    }
    await validateInputs(bundle, profile.files);
    await validateInputs(controls, selectedControls);
    if (plan.syscallPolicy)
      await verifySyscallPreflight(plan, controller.signal, state);
    // The fixed probes execute trusted operator code; re-admit all original bytes
    // before the much longer unchanged upstream build is allowed to start.
    await validateInputs(cProducerDirectory, plan.sources);
    await validateInputs(path.dirname(self), plan.harness);
    await validateInputs(controls, selectedControls);
    await verifyCustodyPreflight(plan, caller, controller.signal, state);
    assert.ok(
      !controller.signal.aborted,
      "Caller custody preflight interrupted before original body",
    );
    observer = await startRetentionObserver({
      destination,
      image: catalog.image,
      platform: catalog.platform,
      attempt,
      environment,
      onFailure: (error) => {
        state.retentionError = String(error);
        controller.abort("retention-observer-unavailable");
      },
    });
    const allowance =
      inputBytes + selectedControls.reduce((sum, row) => sum + row.bytes, 0);
    const measure = async () => {
      const sample = await observer.sample();
      assert.ok(
        sample.bytes <= profile.limits.workByteLimit + allowance,
        "Retained original work exceeded declared bound plus frozen inputs/controls",
      );
      return sample;
    };
    await measure();
    assert.ok(
      !controller.signal.aborted,
      "Retention observation failed before native admission",
    );
    timer = setInterval(() => {
      if (!measuring)
        measuring = measure()
          .catch((error) => {
            state.retentionError = String(error);
            controller.abort("retention-observer-or-limit");
          })
          .finally(() => {
            measuring = undefined;
          });
    }, 1000);
    const argv = cProducerArguments(
      catalog,
      profile,
      destination,
      attempt,
      caller,
    );
    state.state = "starting";
    await atomicReceipt(destination, state);
    state.executionObserver = await observeForeground(
      () => {
        state.originalExecutionInvoked = true;
        state.buildExecuted = null;
        return spawn("docker", argv, {
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      path.join(destination, "build.log"),
      {
        timeoutMs: profile.limits.deadlineSeconds * 1000,
        maxBytes: profile.limits.logByteLimit,
        signal: controller.signal,
        stop,
      },
    );
    clearInterval(timer);
    if (measuring) await measuring;
    state.log = await identifyFile(
      path.join(destination, "build.log"),
      profile.limits.logByteLimit,
    );
    state.cleanup = await stop();
    state.originalBuild = await checkedJson(
      path.join(work, "original-command.json"),
      4096,
    );
    state.buildExecuted = state.originalBuild.invoked;
    state.testEvidence = await verifyCProducerReports(
      await readCProducerCopyManifest(
        path.join(work, "test-reports.json"),
        caller,
      ),
      path.join(work, "original-test-reports"),
      profile,
      caller,
    );
    assert.equal(state.testEvidence.exportCustody.producerEffectiveUid, 0);
    state.outputs = await outputFiles(work, profile.limits.workByteLimit);
    state.nativeBuildWorktree = await identifyFile(
      path.join(work, "native-build-worktree.tar"),
      profile.limits.workByteLimit,
    );
    state.installedPackageIdentities = await identifyFile(
      path.join(work, "installed-build-package-identities.txt"),
      1024 ** 2,
    );
    state.finalRetention = await measure();
    await validateInputs(inputs, profile.files);
    // Mutable APT list/cache copies legitimately change; original inputs remain immutable.
    await validateInputs(cProducerDirectory, plan.sources);
    await validateInputs(path.dirname(self), plan.harness);
    await validateInputs(controls, selectedControls);
    if (plan.syscallPolicy) {
      assert.deepEqual(
        validateGlibcDockerMetadata(
          JSON.parse(
            (await docker(["version", "--format", "{{json .}}"])).stdout,
          ),
          JSON.parse((await docker(["info", "--format", "{{json .}}"])).stdout),
        ),
        syscallRuntime,
        "Qualified Docker metadata changed during original execution",
      );
      for (const mode of ["baseline", "derived"])
        assert.deepEqual(
          await identifyFile(
            path.join(destination, "seccomp-" + mode + ".log"),
            65536,
          ),
          state.syscallPreflight.modes[mode].log,
          "Original syscall preflight log changed",
        );
    }
    assert.deepEqual(
      await identifyFile(
        path.join(destination, "custody-preflight/test-reports.json"),
        65536,
      ),
      state.custodyPreflight.manifest,
      "Caller custody preflight bytes changed",
    );
    assert.deepEqual(
      await identifyFile(
        path.join(destination, "custody-preflight.log"),
        65536,
      ),
      state.custodyPreflight.log,
      "Caller custody preflight log changed",
    );
    assert.deepEqual(
      await image(),
      initialImage,
      "Original image changed during execution",
    );
    assert.ok(
      !controller.signal.aborted,
      "Original build collection interrupted",
    );
    state.buildCompletion = cProducerCompletion(
      state.originalBuild,
      state.executionObserver,
      state.outputs,
      state.testEvidence,
    );
    state.state = state.buildCompletion.state;
  } catch (error) {
    state.state = controller.signal.aborted
      ? "interrupted-or-resource-observer-failure"
      : "failed-or-incomplete";
    state.error = String(error).slice(0, 2000);
    state.executionObserver ??= error?.observedTerminal;
    state.stopTrigger =
      controller.signal.reason ?? state.executionObserver?.reason ?? null;
  } finally {
    clearInterval(timer);
    if (measuring) await measuring;
    for (const [key, action] of [
      [
        "retentionObserver",
        async () => {
          if (!observer) return { state: "not-started" };
          const receipt = await observer.close();
          const raw = await boundedCProducerBytes(
            path.join(destination, "retention-observer.jsonl"),
            16 * 1024 ** 2,
          );
          reconcileRetentionLog(raw, receipt);
          return {
            ...receipt,
            log: await identifyFile(
              path.join(destination, "retention-observer.jsonl"),
              16 * 1024 ** 2,
            ),
          };
        },
      ],
      [
        "retentionObserverCleanup",
        () => cleanupContainer(observerCid, attempt, "retention"),
      ],
      ["cleanup", stop],
    ]) {
      try {
        state[key] = await action();
      } catch (error) {
        state[key] = {
          state: "unavailable",
          error: String(error).slice(0, 1000),
        };
        state.state = "cleanup-or-observation-failed";
      }
    }
    state.finishedAt = new Date().toISOString();
    await atomicReceipt(destination, state);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  return {
    state: state.state,
    receipt: path.join(destination, "receipt.json"),
    gateAComplete: false,
  };
}

export async function mainCProducer(args) {
  assert.ok(
    args.length === 7 || args.length === 8,
    "Usage: node scripts/qualify-c-producer.mjs --profile gcc-12|glibc --inputs BUNDLE --output NEW_DIRECTORY --prepare-only | --operator-trust-execution --coordinated-heavy-slot",
  );
  assert.equal(args[0], "--profile");
  assert.equal(args[2], "--inputs");
  assert.equal(args[4], "--output");
  const prepare = args.length === 7 && args[6] === "--prepare-only";
  assert.ok(
    prepare ||
      (args[6] === "--operator-trust-execution" &&
        args[7] === "--coordinated-heavy-slot"),
    "Execution requires two explicit operator flags",
  );
  const plan = await prepareCProducer(
    args[1],
    path.resolve(args[3]),
    path.resolve(args[5]),
  );
  if (prepare)
    return {
      profile: plan.profile.profile,
      catalogSha256: plan.catalogSha256,
      pinnedInputs: plan.profile.files.length,
      command: plan.profile.command,
      limits: plan.profile.limits,
      sourcePins: plan.sources,
      harnessPins: plan.harness,
      imageIdentity: plan.imageIdentity,
      buildExecuted: false,
      fullCompilerSdkBootstrapClosureVerified: false,
      gateAComplete: false,
    };
  return run(plan);
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    const result = await mainCProducer(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.buildExecuted !== false) process.exitCode = 2; // Full upstream build/notice ancestry remains pending.
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
