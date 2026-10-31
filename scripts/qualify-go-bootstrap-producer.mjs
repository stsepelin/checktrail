// Explicit operator-only development qualification; no product CLI/MCP registration.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  statfs,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
const { AbortController } = globalThis;
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
import { captureCProducerCallerIdentity } from "./qualify-c-producer.mjs";
import {
  registryImageIdentity,
  validateObservedImage,
} from "./producer-qualification/binutils-image-identity.mjs";
import {
  reconcileRetentionLog,
  startRetentionObserver,
} from "./producer-qualification/binutils-retention-observer.mjs";
import { goArchiveRows } from "./acquire-go-bootstrap-inputs.mjs";
import {
  asciiJson,
  completeGoChain,
  completeGoStage,
  goBootstrapCatalogSha256,
  goBootstrapDirectory,
  goProfile,
  goWorkerFiles,
  inspectGoPhysicalTree,
  inspectGoImageTools,
  requireClosedGoProfile,
  loadGoBootstrapCatalog,
  requireCurrentGoPredecessor,
  requireGoPredecessorUnchanged,
  requireOriginalGoPhase,
  sha256,
} from "./producer-qualification/go-bootstrap-profile.mjs";
import {
  captureGoMountIdentity,
  captureGoMountCustody,
  goContainerSpec,
  runGoContainerTransport,
} from "./producer-qualification/go-bootstrap-transport.mjs";
const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const environment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
};
export const goBootstrapSourceFiles = Object.freeze([
  "scripts/qualify-go-bootstrap-producer.mjs",
  "scripts/acquire-go-bootstrap-inputs.mjs",
  "scripts/producer-qualification/go-bootstrap-transport.mjs",
  "scripts/qualify-binutils-producer.mjs",
  "scripts/qualify-c-producer.mjs",
  "scripts/producer-qualification/c-producer-profile.mjs",
  "scripts/producer-qualification/c-producer-profiles.v1.json",
  ...goWorkerFiles.map((file) => "scripts/producer-qualification/" + file),
  ".github/workflows/upstream-go-bootstrap.yml",
  "package.json",
  "package-lock.json",
]);
// The existing observer transport has a fixed entry filename. This closed copy
// binding names the Go-specific byte source explicitly; it is not the BPU program.
const controlBindings = [
  { source: "go-bootstrap.v1.json", target: "go-bootstrap.v1.json" },
  { source: "go-bootstrap-worker.py", target: "go-bootstrap-worker.py" },
  {
    source: "go-bootstrap-retention-observer.py",
    target: "binutils-retention-observer.py",
  },
];
const uuid = (value) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
async function checkedBytes(file, maximum, caller = null) {
  if (caller) {
    const info = await lstat(file);
    assert.equal(info.uid, caller.uid);
    assert.equal(info.gid, caller.gid);
    assert.equal(info.mode & 0o7777, 0o600);
  }
  const identity = await identifyFile(file, maximum),
    raw = await readFile(file);
  assert.equal(raw.length, identity.bytes);
  assert.equal(
    sha256(raw),
    identity.sha256,
    "Physical retained bytes changed after capture",
  );
  return raw;
}
async function syncFile(file) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function syncDirectory(directory) {
  const fd = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function privateJson(file, value) {
  const raw = Buffer.from(asciiJson(value) + "\n");
  assert.ok(raw.length <= 64 * 1024 ** 2, "Private Go packet byte bound");
  const fd = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fd.writeFile(raw);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await syncDirectory(path.dirname(file));
  return { bytes: raw.length, sha256: sha256(raw) };
}
export async function captureGoSourceFrame(root = repository) {
  await physicalPath(root, true);
  const gitEnv = {
    PATH: environment.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.untrackedCache=false",
  ];
  const git = (values) =>
    exec("git", [...args, ...values], {
      cwd: root,
      env: gitEnv,
      timeout: 15000,
      maxBuffer: 1024 ** 2,
    });
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const committed = (
    await git([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      "HEAD",
      "--",
      ...goBootstrapSourceFiles,
    ])
  ).stdout;
  const committedFiles = new Map();
  for (const line of committed.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    assert.ok(
      match && !committedFiles.has(match[3]),
      "Committed controller tree is malformed or duplicated",
    );
    committedFiles.set(match[3], { mode: match[1], sha1: match[2] });
  }
  const files = [];
  let committedControllerSourcesMatch =
    committedFiles.size === goBootstrapSourceFiles.length;
  for (const file of goBootstrapSourceFiles) {
    const full = path.join(root, file),
      identity = await identifyFile(full, 2 * 1024 ** 2),
      raw = await readFile(full),
      info = await lstat(full);
    assert.equal(raw.length, identity.bytes);
    assert.equal(sha256(raw), identity.sha256);
    const gitBlobSha1 = createHash("sha1")
        .update("blob " + raw.length + "\0")
        .update(raw)
        .digest("hex"),
      gitMode = info.mode & 0o111 ? "100755" : "100644";
    const original = committedFiles.get(file);
    committedControllerSourcesMatch &&=
      original?.mode === gitMode && original?.sha1 === gitBlobSha1;
    files.push({ file, ...identity, gitBlobSha1, gitMode });
  }
  const value = {
    schemaVersion: 1,
    checkoutSha: head,
    committedControllerSourcesMatch,
    wholeCheckoutCleanlinessAssessed: false,
    scope:
      "Selected controller and helper files must match the committed checkout tree; repository status hooks and clean filters are not invoked",
    files,
    node: {
      version: process.version,
      ...(await identifyFile(
        await realpath(process.execPath),
        256 * 1024 ** 2,
      )),
    },
    actualModuleLoadsTraced: false,
  };
  return { ...value, sha256: sha256(asciiJson(value) + "\n") };
}
function ciContext() {
  const fields = [
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
  ];
  if (!fields.some((key) => process.env[key])) return null;
  assert.ok(
    fields.every(
      (key) =>
        typeof process.env[key] === "string" && process.env[key].length > 0,
    ),
  );
  return Object.fromEntries(fields.map((key) => [key, process.env[key]]));
}
export async function captureGoStartup(file) {
  const source = await captureGoSourceFrame(),
    caller = captureCProducerCallerIdentity();
  assert.equal(
    source.committedControllerSourcesMatch,
    true,
    "Native producer startup requires committed controller source bytes and modes",
  );
  if (process.env.GITHUB_SHA)
    assert.equal(
      source.checkoutSha,
      process.env.GITHUB_SHA,
      "Checkout SHA differs from event checkout identity",
    );
  const startup = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source,
    caller,
    ci: ciContext(),
    scope: "fresh-native-original-upstream-source",
    historicalManifestAuthority: "comparison-only",
    hardwareHostAttestationPerformed: false,
  };
  await physicalPath(path.dirname(path.resolve(file)), true);
  await privateJson(path.resolve(file), startup);
  return startup;
}
export async function prepareGoBootstrap(inputs, output) {
  const catalog = await loadGoBootstrapCatalog();
  await physicalPath(inputs, true);
  const rows = goArchiveRows(catalog);
  await validateInputs(path.join(inputs, "archives"), rows);
  const { destination, parent } = await validateDestination(inputs, output);
  const sources = [];
  for (const file of goBootstrapSourceFiles)
    sources.push({
      file,
      ...(await identifyFile(path.join(repository, file), 2 * 1024 ** 2)),
    });
  const record = JSON.parse(
    await readFile(
      path.join(goBootstrapDirectory, "binutils-image-identity.v1.json"),
      "utf8",
    ),
  );
  return {
    schemaVersion: 1,
    catalog,
    catalogSha256: goBootstrapCatalogSha256,
    inputs: path.resolve(inputs),
    destination,
    parent,
    archives: rows,
    sources,
    imageIdentity: registryImageIdentity(record, catalog.profiles[0].image),
    pinnedImageConfig: JSON.parse(
      Buffer.from(record.config.base64, "base64").toString("utf8"),
    ).config,
    buildExecuted: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    gateAComplete: false,
  };
}
function baseArgs({ attempt, cid, memory, cpus, pids }) {
  assert.ok(uuid(attempt));
  return [
    "create",
    "--attach=STDOUT",
    "--attach=STDERR",
    "--init",
    "--pull=never",
    "--platform",
    "linux/amd64",
    "--name",
    "checktrail-producer-" + attempt,
    "--cidfile",
    cid,
    "--label",
    "io.checktrail.producer-attempt=" + attempt,
    "--label",
    "io.checktrail.producer-role=go-bootstrap",
    "--network",
    "none",
    "--user",
    "0:0",
    "--cpus",
    String(cpus),
    "--memory",
    String(memory),
    "--pids-limit",
    String(pids),
  ];
}
export function originalGoArguments(
  profile,
  phase,
  { attempt, cid, stageWork, predecessorRoot, image },
) {
  requireClosedGoProfile(profile);
  assert.deepEqual(
    profile.originalCommands.find((row) => row.phase === phase.phase),
    phase,
  );
  assert.ok(
    path.isAbsolute(stageWork) &&
      path.isAbsolute(cid) &&
      ![stageWork, cid].some((value) => /[\r\n,]/u.test(value)),
  );
  assert.equal(image, profile.image);
  assert.equal(Boolean(predecessorRoot), Boolean(profile.predecessor));
  const args = baseArgs({
    attempt,
    cid,
    image,
    memory: profile.limits.memoryBytes,
    cpus: profile.limits.cpus,
    pids: profile.limits.pidsLimit,
  });
  args.push(
    "--entrypoint",
    "/bin/bash",
    "--mount",
    "type=bind,src=" + stageWork + ",target=/work",
    "--workdir",
    phase.cwd,
  );
  if (predecessorRoot) {
    assert.ok(
      path.isAbsolute(predecessorRoot) && !/[\r\n,]/u.test(predecessorRoot),
    );
    args.push(
      "--mount",
      "type=bind,src=" + predecessorRoot + ",target=/bootstrap,readonly",
    );
  }
  for (const [key, value] of Object.entries(profile.environment))
    args.push("--env", key + "=" + value);
  return [...args, image, ...phase.argv];
}
export function goObserverArguments(
  profile,
  mode,
  { attempt, cid, stageWork, predecessorRoot, destination },
) {
  requireClosedGoProfile(profile);
  assert.ok(["prepare", "observe"].includes(mode));
  const args = baseArgs({
    attempt,
    cid,
    image: profile.image,
    memory: 512 * 1024 ** 2,
    cpus: 1,
    pids: 64,
  });
  args.push(
    "--entrypoint",
    "/usr/bin/python3",
    "--workdir",
    "/",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--mount",
    "type=bind,src=" +
      path.join(destination, "controls") +
      ",target=/controls,readonly",
  );
  if (mode === "prepare")
    args.push(
      "--cap-add=DAC_OVERRIDE",
      "--mount",
      "type=bind,src=" +
        path.join(destination, "bundle") +
        ",target=/bundle,readonly",
      "--mount",
      "type=bind,src=" + stageWork + ",target=/work",
    );
  else {
    args.push(
      "--read-only",
      "--cap-add=DAC_READ_SEARCH",
      "--mount",
      "type=bind,src=" +
        path.join(stageWork, "go") +
        ",target=/observed/sdk,readonly",
    );
    if (predecessorRoot)
      args.push(
        "--mount",
        "type=bind,src=" +
          predecessorRoot +
          ",target=/observed/bootstrap,readonly",
      );
  }
  return [
    ...args,
    profile.image,
    "-I",
    "-S",
    "-B",
    "/controls/go-bootstrap-worker.py",
    mode,
    profile.id,
  ];
}
async function dockerExecutable() {
  for (const directory of environment.PATH.split(":")) {
    const invocation = path.join(directory, "docker");
    try {
      const canonical = await realpath(invocation);
      return {
        invocation,
        canonical,
        ...(await identifyFile(canonical, 256 * 1024 ** 2)),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw Error("Pinned producer transport executable unavailable");
}
function terminalSucceeded(result) {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    result.reason === null &&
    result.stopError === null
  );
}
export async function runGoBootstrap(plan, startupFile) {
  assert.equal(
    process.platform,
    "linux",
    "Native source observation requires a Linux host",
  );
  assert.equal(
    process.arch,
    "x64",
    "Native source observation requires x64 Node",
  );
  assert.equal(
    os.machine(),
    "x86_64",
    "Native source observation requires an observed x86_64 kernel machine",
  );
  const caller = captureCProducerCallerIdentity();
  const startup = JSON.parse(
    await checkedBytes(path.resolve(startupFile), 2 * 1024 ** 2, caller),
  );
  assert.equal(startup.schemaVersion, 1);
  assert.deepEqual(startup.caller, caller);
  assert.deepEqual(startup.ci, ciContext());
  const source = await captureGoSourceFrame();
  assert.equal(source.committedControllerSourcesMatch, true);
  assert.deepEqual(
    startup.source,
    source,
    "Producer source changed after operator startup",
  );
  assert.equal(startup.scope, "fresh-native-original-upstream-source");
  assert.equal(startup.historicalManifestAuthority, "comparison-only");
  const began = Date.parse(startup.createdAt),
    deadline = began + plan.catalog.observationLimits.observationSeconds * 1000;
  assert.ok(
    Number.isFinite(began) && began <= Date.now() && Date.now() < deadline,
    "Fixed startup observation window is unavailable",
  );
  await caseSensitiveParent(plan.parent);
  const transport = await dockerExecutable();
  const docker = (args) =>
    exec(transport.invocation, args, {
      env: environment,
      timeout: 15000,
      maxBuffer: 2 * 1024 ** 2,
    });
  const server = JSON.parse(
    (await docker(["version", "--format", "{{json .Server}}"])).stdout,
  );
  assert.equal(server.Os, "linux");
  assert.equal(server.Arch, "amd64");
  const initialImage = validateObservedImage(
    JSON.parse(
      (await docker(["image", "inspect", plan.catalog.profiles[0].image]))
        .stdout,
    )[0],
    plan.imageIdentity,
  );
  const initialFree = await statfs(plan.parent, { bigint: true });
  assert.ok(
    initialFree.bavail * initialFree.bsize >= 2n * 1024n ** 3n,
    "Free-space admission refused before native source commands",
  );
  await mkdir(plan.destination, { mode: 0o700 });
  const work = path.join(plan.destination, "work"),
    bundle = path.join(plan.destination, "bundle"),
    controls = path.join(plan.destination, "controls"),
    evidence = path.join(work, "evidence");
  for (const directory of [
    work,
    bundle,
    controls,
    evidence,
    path.join(work, "stages"),
    path.join(bundle, "archives"),
  ])
    await mkdir(directory, { mode: 0o700 });
  const abort = new AbortController(),
    interrupt = () => abort.abort("caller-signal");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const chainAttempt = randomUUID();
  const state = {
    schemaVersion: 1,
    chainAttempt,
    profile: plan.catalog.profile,
    catalogSha256: plan.catalogSha256,
    sourceFrame: source,
    caller,
    startup,
    host: {
      platform: process.platform,
      architecture: process.arch,
      kernelMachine: os.machine(),
      release: os.release(),
      dockerServer: server,
      transport,
      image: initialImage,
      hardwareHostAttestationPerformed: false,
    },
    limits: plan.catalog.observationLimits,
    state: "preparing",
    buildExecuted: false,
    executions: [],
    stages: [],
    rawBytes: 0,
    rawTransport:
      "Docker client stdout/stderr observed event-order merged by parent; native stream interleaving is not claimed",
    nativeStreamInterleavingCaptured: false,
    sourceFilesPatched: false,
    originalRuntimeSuitesExecuted: false,
    retentionError: null,
    storageError: null,
    freshNativeUpstreamSourceAncestryComplete: false,
    exactHistoricalPrivateInputReplay: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
  const save = async () => {
    try {
      await atomicReceipt(plan.destination, state);
      await syncFile(path.join(plan.destination, "receipt.json"));
      await syncDirectory(plan.destination);
    } catch (error) {
      state.storageError ??= String(error);
      abort.abort("receipt-storage-failed");
      throw error;
    }
  };
  const cutoffTimer = setTimeout(
    () => abort.abort("external-observation-cutoff"),
    Math.max(1, deadline - Date.now()),
  );
  cutoffTimer.unref();
  let observer, measuring, timer, firstTools;
  const active = new Map(),
    completed = new Map(),
    sdkRoots = new Map();
  const measure = () => {
    if (measuring) return measuring;
    measuring = (async () => {
      const sample = await observer.sample();
      assert.ok(
        sample.bytes <= plan.catalog.observationLimits.workBytes,
        "New owned-work observation cap reached",
      );
      const free = await statfs(plan.parent, { bigint: true });
      assert.ok(
        free.bavail * free.bsize >= 512n * 1024n ** 2n,
        "Free-space observation floor reached",
      );
      state.lastIndependentRetention = sample;
      state.freeBytes = (free.bavail * free.bsize).toString();
      return sample;
    })()
      .catch((error) => {
        state.retentionError ??= String(error);
        abort.abort("retention-observer-or-space-refusal");
        throw error;
      })
      .finally(() => {
        measuring = null;
      });
    return measuring;
  };
  const execute = async (
    label,
    args,
    timeoutSeconds,
    metadata = {},
    protectedSdk = null,
  ) => {
    assert.ok(
      !abort.signal.aborted && Date.now() < deadline,
      "Native phase refused after interruption or external cutoff",
    );
    const commandDeadline = Math.min(
      deadline,
      Date.now() + timeoutSeconds * 1000,
    );
    const attempt = args[args.indexOf("--name") + 1].slice(
        "checktrail-producer-".length,
      ),
      cid = args[args.indexOf("--cidfile") + 1];
    assert.ok(uuid(attempt));
    const spec = goContainerSpec(args, plan.pinnedImageConfig, initialImage.id);
    const protectedRoot = protectedSdk?.root ?? null;
    const initialCustody = await captureGoMountCustody(
      spec.mounts,
      protectedRoot,
      protectedSdk?.identity ?? null,
    );
    const row = {
      label,
      attempt,
      argv: args,
      originalAssertionsSatisfied: false,
      ownedContainerAbsent: false,
      physicalCommands: [],
      mountCustody: initialCustody,
      ...metadata,
    };
    state.executions.push(row);
    state.activeAttempt = attempt;
    active.set(attempt, cid);
    await save();
    const stop = () => cleanupContainer(cid, attempt);
    const invoke = async (
      operation,
      argv,
      timeoutMs,
      cleanupObservation = false,
    ) => {
      const physicalAttempt = randomUUID(),
        relative = "evidence/" + physicalAttempt + ".log",
        file = path.join(work, relative);
      const command = {
        operation,
        attempt: physicalAttempt,
        argv,
        timeoutMs,
        cleanupObservation,
      };
      row.physicalCommands.push(command);
      if (operation === "start-attached") row.nativeStartRequested = true;
      await save();
      let counted = false;
      try {
        const remaining =
          plan.catalog.observationLimits.aggregateOutputBytes - state.rawBytes;
        assert.ok(
          remaining > 0,
          "Aggregate raw-output observation cap reached",
        );
        const result = await observeForeground(
          () =>
            spawn(transport.invocation, argv, {
              env: environment,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          file,
          {
            timeoutMs,
            maxBytes: Math.min(
              plan.catalog.observationLimits.commandOutputBytes,
              remaining,
            ),
            signal: cleanupObservation
              ? new AbortController().signal
              : abort.signal,
            stop,
          },
        );
        command.terminal = result;
        command.deadlineCause =
          result.reason === "deadline"
            ? Date.now() >= deadline
              ? "external-observation-cutoff"
              : metadata.kind === "original"
                ? "original-command-timeout"
                : "metadata-command-timeout"
            : null;
        await syncFile(file);
        command.raw = {
          file: relative,
          ...(await identifyFile(
            file,
            plan.catalog.observationLimits.commandOutputBytes,
          )),
        };
        state.rawBytes += command.raw.bytes;
        counted = true;
        await save();
        const raw = await checkedBytes(
          file,
          plan.catalog.observationLimits.commandOutputBytes,
          caller,
        );
        assert.equal(sha256(raw), command.raw.sha256);
        return {
          terminal: result,
          text: raw.toString("utf8"),
          raw: command.raw,
          deadlineCause: command.deadlineCause,
        };
      } catch (error) {
        command.failure = String(error);
        if (error.observedTerminal)
          command.observedTerminal = error.observedTerminal;
        try {
          command.raw = {
            file: relative,
            ...(await identifyFile(
              file,
              plan.catalog.observationLimits.commandOutputBytes,
            )),
          };
        } catch {
          /* The log can be absent after an actual pre-start storage refusal. */
        }
        if (command.raw && !counted) state.rawBytes += command.raw.bytes;
        await save();
        throw error;
      }
    };
    let result;
    try {
      result = await runGoContainerTransport({
        args,
        spec,
        protectedRoot,
        deadline: commandDeadline,
        custody: async () =>
          assert.deepEqual(
            await captureGoMountCustody(
              spec.mounts,
              protectedRoot,
              protectedSdk?.identity ?? null,
            ),
            initialCustody,
            "Physical mount roots changed before/after native execution",
          ),
        invoke,
        record: async (observation) => {
          (row.configurationObservations ??= []).push(observation);
          if (
            observation.phase === "after-terminal" &&
            metadata.kind === "original"
          )
            state.buildExecuted = true;
          await save();
        },
        cleanup: async () => {
          row.cleanup = await cleanupContainer(cid, attempt);
          row.ownedContainerAbsent = true;
          active.delete(attempt);
        },
      });
      row.terminal = result.terminal;
      row.nativeState = result.nativeState;
      row.raw = result.raw;
      row.deadlineCause = result.deadlineCause;
    } catch (error) {
      row.failure = String(error);
      if (!row.ownedContainerAbsent) {
        row.cleanupFailure = "Owned container cleanup did not complete";
        abort.abort("owned-cleanup-failed");
      }
      throw error;
    } finally {
      delete state.activeAttempt;
      await save();
    }
    await measure();
    return { row, text: result.text };
  };
  const metadata = async (profile, mode, stageWork, predSdk) => {
    const predRoot = predSdk?.root ?? null;
    const attempt = randomUUID(),
      cid = path.join(plan.destination, attempt + ".cid"),
      args = goObserverArguments(profile, mode, {
        attempt,
        cid,
        stageWork,
        predecessorRoot: predRoot,
        destination: plan.destination,
      });
    const observed = await execute(
      profile.id + ":" + mode,
      args,
      120,
      {
        kind: "metadata",
        stage: profile.id,
      },
      predSdk,
    );
    assert.ok(
      terminalSucceeded(observed.row.terminal),
      "Fixed source preparation or read-only SDK observation failed",
    );
    const value = JSON.parse(observed.text);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.stage, profile.id);
    return value;
  };
  try {
    await save();
    for (const row of plan.archives)
      await copyPinnedInput(
        path.join(plan.inputs, "archives", row.file),
        path.join(bundle, "archives", row.file),
        row,
      );
    state.retainedControlFiles = [];
    for (const binding of controlBindings) {
      const pin = plan.sources.find(
        (row) =>
          row.file === "scripts/producer-qualification/" + binding.source,
      );
      assert.ok(pin);
      await copyPinnedInput(
        path.join(goBootstrapDirectory, binding.source),
        path.join(controls, binding.target),
        pin,
      );
      state.retainedControlFiles.push({
        ...binding,
        bytes: pin.bytes,
        sha256: pin.sha256,
      });
    }
    await validateInputs(path.join(bundle, "archives"), plan.archives);
    const outerAttempt = randomUUID();
    observer = await startRetentionObserver({
      destination: plan.destination,
      image: plan.catalog.profiles[0].image,
      platform: "linux/amd64",
      attempt: outerAttempt,
      environment,
      onFailure: (error) => {
        state.retentionError ??= String(error);
        abort.abort("retention-observer-unavailable");
      },
    });
    state.retentionAttempt = outerAttempt;
    await measure();
    timer = setInterval(() => {
      void measure().catch(() => {});
    }, 2000);
    timer.unref();
    state.state = "running";
    await save();
    for (const id of plan.catalog.requiredStages) {
      assert.ok(
        !abort.signal.aborted && Date.now() < deadline,
        "External observation stopped the original source chain",
      );
      const profile = goProfile(plan.catalog, id),
        attempt = randomUUID(),
        stageWork = path.join(work, "stages", id);
      await mkdir(stageWork, { mode: 0o700 });
      const predecessor = requireCurrentGoPredecessor(
          profile,
          completed,
          source.sha256,
          chainAttempt,
        ),
        predSdk = predecessor ? sdkRoots.get(predecessor.stage) : null,
        predRoot = predSdk?.root ?? null;
      assert.equal(Boolean(predRoot), Boolean(predecessor));
      const prepared = await metadata(profile, "prepare", stageWork, null);
      assert.equal(prepared.buildExecuted, false);
      assert.deepEqual(prepared.sourceArchive, {
        bytes: profile.sourceArchive.bytes,
        sha256: profile.sourceArchive.sha256,
      });
      inspectGoPhysicalTree(prepared.sourceTree);
      assert.equal(
        prepared.sourceTree.entries.filter((row) => row.kind !== "directory")
          .length,
        profile.sourceFiles,
        "Original source archive entry inventory differs",
      );
      let observed = await metadata(profile, "observe", stageWork, predSdk);
      inspectGoPhysicalTree(observed.sdkTree);
      requireGoPredecessorUnchanged(predecessor, observed.bootstrapTree);
      inspectGoImageTools(observed.imageTools);
      firstTools ??= observed.imageTools;
      assert.deepEqual(
        observed.imageTools,
        firstTools,
        "Actual compiler/interpreter/linker bytes changed",
      );
      const phases = [];
      for (const command of profile.originalCommands) {
        const phaseAttempt = randomUUID(),
          cid = path.join(plan.destination, phaseAttempt + ".cid");
        const args = originalGoArguments(profile, command, {
          attempt: phaseAttempt,
          cid,
          stageWork,
          predecessorRoot: predRoot,
          image: profile.image,
        });
        const result = await execute(
          id + ":" + command.phase,
          args,
          command.timeoutSeconds,
          { kind: "original", stage: id, phase: command.phase, command },
          predSdk,
        );
        requireOriginalGoPhase(
          profile,
          command,
          result.row.terminal,
          result.text,
        );
        result.row.originalAssertionsSatisfied = true;
        phases.push(result.row);
        await save();
        observed = await metadata(profile, "observe", stageWork, predSdk);
        requireGoPredecessorUnchanged(predecessor, observed.bootstrapTree);
        inspectGoImageTools(observed.imageTools);
        assert.deepEqual(
          observed.imageTools,
          firstTools,
          "Actual compiler/interpreter/linker bytes changed",
        );
      }
      const sealed = completeGoStage({
        profile,
        attempt,
        sourceFrameSha256: source.sha256,
        chainAttempt,
        phases,
        before: prepared.sourceTree,
        sdkTree: observed.sdkTree,
        predecessor,
      });
      const packetFile = "evidence/" + id + ".sealed.json",
        packet = { ...sealed, originalSourceTree: prepared.sourceTree, phases };
      const packetPin = await privateJson(path.join(work, packetFile), packet);
      completed.set(id, sealed);
      const sealedRoot = path.join(stageWork, "go");
      sdkRoots.set(id, {
        root: sealedRoot,
        identity: await captureGoMountIdentity(sealedRoot),
      });
      state.stages.push({
        stage: id,
        attempt,
        seal: sealed.seal,
        predecessor,
        packet: { file: packetFile, ...packetPin },
        freshNativeUpstreamSourceAncestryComplete: true,
        exactHistoricalPrivateInputReplay:
          sealed.exactHistoricalPrivateInputReplay,
        historicalRegularOutputComparison:
          sealed.historicalRegularOutputComparison,
      });
      await save();
    }
    const summary = completeGoChain(
      [...completed.values()],
      source.sha256,
      chainAttempt,
    );
    await measure();
    assert.ok(
      Date.now() < deadline && !abort.signal.aborted,
      "External observation cutoff precedes completed source chain",
    );
    for (const row of state.executions.flatMap((row) => row.physicalCommands)) {
      const raw = await checkedBytes(
        path.join(work, row.raw.file),
        plan.catalog.observationLimits.commandOutputBytes,
        caller,
      );
      assert.equal(raw.length, row.raw.bytes);
      assert.equal(sha256(raw), row.raw.sha256);
    }
    for (const row of state.stages) {
      const raw = await checkedBytes(
        path.join(work, row.packet.file),
        64 * 1024 ** 2,
        caller,
      );
      assert.equal(raw.length, row.packet.bytes);
      assert.equal(sha256(raw), row.packet.sha256);
    }
    await validateInputs(path.join(bundle, "archives"), plan.archives);
    assert.deepEqual(
      await captureGoSourceFrame(),
      source,
      "Current source/caller/controller inputs changed during native observation",
    );
    assert.deepEqual(
      await dockerExecutable(),
      transport,
      "Actual Docker invocation or canonical binary bytes changed",
    );
    assert.deepEqual(
      validateObservedImage(
        JSON.parse(
          (await docker(["image", "inspect", plan.catalog.profiles[0].image]))
            .stdout,
        )[0],
        plan.imageIdentity,
      ),
      initialImage,
    );
    assert.equal(state.retentionError, null);
    assert.equal(state.storageError, null);
    assert.ok(
      Date.now() < deadline && !abort.signal.aborted,
      "External observation cutoff before final source closure",
    );
    state.summary = summary;
  } catch (error) {
    state.state = "failed-or-incomplete";
    state.failure = String(error);
    abort.abort("source-chain-incomplete");
  } finally {
    clearTimeout(cutoffTimer);
    clearInterval(timer);
    if (measuring) await measuring.catch(() => {});
    for (const [attempt, cid] of active) {
      try {
        await cleanupContainer(cid, attempt);
        active.delete(attempt);
      } catch (error) {
        state.cleanupFailure ??= String(error);
      }
    }
    if (observer) {
      try {
        state.retention = await observer.close();
        await syncFile(path.join(plan.destination, "retention-observer.jsonl"));
        const raw = await checkedBytes(
          path.join(plan.destination, "retention-observer.jsonl"),
          16 * 1024 ** 2,
          caller,
        );
        reconcileRetentionLog(raw, state.retention);
      } catch (error) {
        state.retentionError ??= String(error);
      }
      try {
        await cleanupContainer(
          path.join(plan.destination, "retention-observer.id"),
          state.retentionAttempt,
          "retention",
        );
      } catch (error) {
        state.cleanupFailure ??= String(error);
      }
    }
    state.ownedClientsAndContainersCleaned =
      active.size === 0 &&
      !state.cleanupFailure &&
      state.retention?.state === "completed";
    if (
      state.summary &&
      state.ownedClientsAndContainersCleaned &&
      !state.retentionError &&
      !state.storageError
    ) {
      state.state = "completed-current-source-observation";
      state.freshNativeUpstreamSourceAncestryComplete = true;
      state.exactHistoricalPrivateInputReplay =
        state.summary.exactHistoricalPrivateInputReplay;
    }
    await save();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  assert.equal(
    state.freshNativeUpstreamSourceAncestryComplete,
    true,
    "Original Go source observation is incomplete; retained failures cannot qualify ancestry",
  );
  return state;
}
export async function mainGoBootstrap(args) {
  if (args[0] === "--capture-startup") {
    assert.equal(args.length, 2);
    return captureGoStartup(args[1]);
  }
  assert.ok(
    ["--prepare", "--run"].includes(args[0]),
    "Use --prepare or explicit --run; arbitrary execution arguments are unavailable",
  );
  assert.equal(args.length, args[0] === "--run" ? 4 : 3);
  const plan = await prepareGoBootstrap(
    path.resolve(args[1]),
    path.resolve(args[2]),
  );
  if (args[0] === "--prepare") return plan;
  return runGoBootstrap(plan, args[3]);
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const report = await mainGoBootstrap(process.argv.slice(2));
    process.stdout.write(JSON.stringify(report) + "\n");
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
  }
}
