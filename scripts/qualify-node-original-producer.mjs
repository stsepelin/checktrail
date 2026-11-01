// Explicit operator-only producer. Product discovery and MCP never register it.
import assert from "node:assert/strict";
import console from "node:console";
import { Buffer } from "node:buffer";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
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
import { startRetentionObserver } from "./producer-qualification/binutils-retention-observer.mjs";
import { captureGoMountCustody } from "./producer-qualification/go-bootstrap-transport.mjs";
import {
  nodeContainerSpec,
  runNodeContainerTransport,
  nodeOriginalNetworkPolicy,
} from "./producer-qualification/node-original-transport.mjs";
import {
  nodeOriginalCatalog,
  nodeOriginalCatalogSha256,
  requireNodeOriginalCatalog,
  inspectNodeDocArchiveManifest,
  inspectNodeImageTools,
  inspectNodePythonSelection,
  nodeOriginalCommand,
  nodeOriginalCacheCommand,
  classifyNodeOriginalCompletion,
  nodeOriginalInputRows,
  requireNodeOriginalEnvironment,
} from "./producer-qualification/node-original-profile.mjs";
import { reconcileNodeRetention } from "./producer-qualification/node-original-retention.mjs";

const exec = promisify(execFile);
const { AbortController } = globalThis;
const repository = fileURLToPath(new URL("../", import.meta.url));
const environment = Object.freeze({
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  DOCKER_HOST: "unix:///var/run/docker.sock",
});
const successful = (row) =>
  row?.exitCode === 0 &&
  row.signal === null &&
  row.error === null &&
  row.reason === null &&
  row.stopError === null;
const sha = (raw) => createHash("sha256").update(raw).digest("hex");
export const nodeOriginalFailure = (error, depth = 0) => {
  const raw = Buffer.from(String(error));
  const value = {
    type: error?.name ?? "Error",
    prefix: raw.subarray(0, 512).toString("utf8"),
    bytes: raw.length,
    sha256: sha(raw),
  };
  const errors =
    error instanceof AggregateError
      ? error.errors
      : error?.cause
        ? [error.cause]
        : [];
  if (errors.length && depth < 2)
    value.causes = errors
      .slice(0, 8)
      .map((cause) => nodeOriginalFailure(cause, depth + 1));
  if (errors.length > 8 || (errors.length && depth >= 2))
    value.unexpandedCauses = errors.length;
  return value;
};
const failure = nodeOriginalFailure;
export function combineNodeOriginalFailure(first, next) {
  return first
    ? new AggregateError(
        [first, next],
        "Original Node primary and secondary failures",
        { cause: first },
      )
    : next;
}
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
    value,
  );
const frame = (row) => [
  row.dev,
  row.ino,
  row.mode,
  row.uid,
  row.gid,
  row.nlink,
  row.size,
  row.mtimeNs,
  row.ctimeNs,
];

export const nodeOriginalSourceFiles = Object.freeze([
  "scripts/qualify-node-original-producer.mjs",
  "scripts/acquire-node-original-inputs.mjs",
  "scripts/producer-qualification/node-original.v1.json",
  "scripts/producer-qualification/node-original-profile.mjs",
  "scripts/producer-qualification/node-original-source.py",
  "scripts/producer-qualification/node-original-worker.py",
  "scripts/producer-qualification/node-original-retention-observer.py",
  "scripts/producer-qualification/node-original-retention.mjs",
  "scripts/producer-qualification/node-original-transport.mjs",
  "scripts/producer-qualification/go-bootstrap-transport.mjs",
  "scripts/producer-qualification/go-bootstrap-profile.mjs",
  "scripts/producer-qualification/go-bootstrap.v1.json",
  "scripts/qualify-binutils-producer.mjs",
  "scripts/qualify-c-producer.mjs",
  "scripts/producer-qualification/c-producer-profile.mjs",
  "scripts/producer-qualification/c-producer-profiles.v1.json",
  "scripts/producer-qualification/glibc-seccomp.mjs",
  "scripts/producer-qualification/binutils-retention-observer.mjs",
  "scripts/producer-qualification/binutils-image-identity.mjs",
  "scripts/producer-qualification/binutils-image-identity.v1.json",
  ".github/workflows/upstream-node-original.yml",
  "package.json",
  "package-lock.json",
]);
const controls = Object.freeze([
  ["node-original.v1.json", "node-original.v1.json"],
  ["node-original-source.py", "node-original-source.py"],
  ["node-original-worker.py", "node-original-worker.py"],
  ["node-original-retention-observer.py", "binutils-retention-observer.py"],
]);
const callerPreflight = `import os,json,hashlib\nfrom pathlib import Path\np=Path('/probe/root-readable.bin');raw=b'Original Node root UID readability fixture\\n'\nassert os.geteuid()==0 and os.getegid()==0\nfd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644);first=None;secondary=[]\ntry:\n count=0\n while count<len(raw):\n  n=os.write(fd,raw[count:]);assert n>0;count+=n\n os.fchmod(fd,0o644);os.fsync(fd);s=os.fstat(fd)\nexcept BaseException as e:first=e\nfinally:\n try:os.close(fd)\n except BaseException as e:\n  secondary.append({'type':type(e).__name__,'message':str(e)[:256]})\n  if first is None:first=e\nif first is not None:\n print(json.dumps({'state':'synthetic-root-export-refused','primaryType':type(first).__name__,'primaryMessage':str(first)[:256],'secondaries':secondary}),flush=True)\n raise SystemExit(2)\nprint(json.dumps({'schemaVersion':1,'state':'synthetic-root-export-readable','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'nativeUid':s.st_uid,'nativeGid':s.st_gid,'nativeMode':s.st_mode&0o7777,'originalSourceOrCompilerExecuted':False}),flush=True)`;

async function boundedBytes(file, maximum, caller = null) {
  await physicalPath(file);
  const before = await lstat(file, { bigint: true });
  assert.ok(before.isFile() && before.size <= BigInt(maximum));
  if (caller) {
    assert.equal(before.uid, BigInt(caller.uid));
    assert.equal(before.gid, BigInt(caller.gid));
    assert.equal(Number(before.mode & 0o7777n), 0o600);
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let answer, first;
  try {
    assert.deepEqual(frame(await handle.stat({ bigint: true })), frame(before));
    const raw = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < raw.length) {
      const { bytesRead } = await handle.read(
        raw,
        count,
        raw.length - count,
        null,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    assert.equal(
      BigInt(count),
      before.size,
      "Bounded metadata grew or was truncated",
    );
    assert.deepEqual(frame(await handle.stat({ bigint: true })), frame(before));
    assert.deepEqual(frame(await lstat(file, { bigint: true })), frame(before));
    answer = raw.subarray(0, count);
  } catch (error) {
    first = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      first = first
        ? new AggregateError([first, error], "Metadata read and close failed", {
            cause: first,
          })
        : error;
    }
  }
  if (first) throw first;
  return answer;
}

async function privateJson(file, value, maximum = 2 * 1024 ** 2) {
  const raw = Buffer.from(JSON.stringify(value) + "\n");
  assert.ok(raw.length <= maximum);
  const handle = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let first;
  try {
    let offset = 0;
    while (offset < raw.length) {
      const { bytesWritten } = await handle.write(
        raw,
        offset,
        raw.length - offset,
      );
      assert.ok(bytesWritten > 0);
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    first = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      first = first
        ? new AggregateError(
            [first, error],
            "Metadata write and close failed",
            { cause: first },
          )
        : error;
    }
  }
  if (first) throw first;
  return { bytes: raw.length, sha256: sha(raw) };
}

export { nodeOriginalInputRows };
function ciContext() {
  const read = (name) => process.env[name] || null;
  return Object.fromEntries(
    [
      "GITHUB_REPOSITORY",
      "GITHUB_SHA",
      "GITHUB_REF_NAME",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_JOB",
    ].map((name) => [name, read(name)]),
  );
}
export async function captureNodeOriginalSource(root = repository) {
  await physicalPath(root, true);
  const git = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
  ];
  const head = (
    await exec("git", [...git, "rev-parse", "HEAD"], {
      cwd: root,
      env: environment,
      timeout: 5000,
      maxBuffer: 128,
    })
  ).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/u);
  const rows = [];
  for (const file of nodeOriginalSourceFiles) {
    const raw = await boundedBytes(path.join(root, file), 2 * 1024 ** 2);
    const committed = await exec("git", [...git, "show", head + ":" + file], {
      cwd: root,
      env: environment,
      timeout: 5000,
      maxBuffer: 2 * 1024 ** 2,
      encoding: "buffer",
    });
    assert.ok(
      Buffer.from(committed.stdout).equals(raw),
      "Original Node controller source is not the committed source: " + file,
    );
    rows.push({ file, bytes: raw.length, sha256: sha(raw) });
  }
  return {
    gitHead: head,
    files: rows,
    sha256: sha(Buffer.from(JSON.stringify(rows))),
    committedControllerSourcesMatch: true,
    projectOrCompilerExecuted: false,
  };
}
export async function captureNodeOriginalStartup(file) {
  const caller = captureCProducerCallerIdentity();
  const value = {
    schemaVersion: 1,
    scope: "fresh-original-node-source-operator-startup",
    createdAt: new Date().toISOString(),
    caller,
    host: {
      platform: process.platform,
      architecture: process.arch,
      machine: os.machine(),
    },
    operatorNodeVersion: process.version,
    source: await captureNodeOriginalSource(),
    ci: ciContext(),
    publishedNodeBootstrapMountedIntoProducer: false,
    sourceOrCompilerExecuted: false,
    gateAComplete: false,
  };
  await privateJson(path.resolve(file), value);
  return value;
}

export async function prepareNodeOriginal(inputs, output, docManifestFile) {
  const catalog = nodeOriginalCatalog(),
    source = await physicalPath(path.resolve(inputs), true);
  const manifest = inspectNodeDocArchiveManifest(
    JSON.parse(await boundedBytes(path.resolve(docManifestFile), 512 * 1024)),
  );
  const rows = nodeOriginalInputRows();
  await validateInputs(source, rows);
  const { destination, parent } = await validateDestination(source, output);
  const imageRecord = JSON.parse(
    await boundedBytes(
      path.join(
        repository,
        "scripts/producer-qualification/binutils-image-identity.v1.json",
      ),
      1024 ** 2,
    ),
  );
  return {
    catalog,
    catalogSha256: nodeOriginalCatalogSha256,
    source,
    destination,
    parent,
    inputRows: rows,
    docManifest: manifest,
    imageIdentity: registryImageIdentity(imageRecord, catalog.image),
    pinnedImageConfig: JSON.parse(
      Buffer.from(imageRecord.config.base64, "base64").toString("utf8"),
    ).config,
  };
}

function baseArguments(catalog, { attempt, cid, memory, cpus, pids }) {
  requireNodeOriginalCatalog(catalog);
  assert.ok(uuid(attempt));
  assert.ok(path.isAbsolute(cid) && !/[\r\n,]/u.test(cid));
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
    "io.checktrail.producer-role=node-original",
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
export function nodeOriginalArguments(kind, selector, bindings) {
  const catalog = nodeOriginalCatalog();
  const { attempt, cid, stageWork, destination } = bindings;
  for (const value of [stageWork, destination])
    assert.ok(path.isAbsolute(value) && !/[\r\n,]/u.test(value));
  const metadata = kind === "metadata" || kind === "caller-preflight";
  const args = baseArguments(catalog, {
    attempt,
    cid,
    cpus: metadata ? 1 : catalog.limits.cpus,
    memory: metadata ? 512 * 1024 ** 2 : catalog.limits.memoryBytes,
    pids: metadata ? 64 : catalog.limits.pidsLimit,
  });
  assert.ok(
    Object.hasOwn(nodeOriginalNetworkPolicy, kind),
    "Unknown original Node stage kind",
  );
  args.push("--network", nodeOriginalNetworkPolicy[kind]);
  args.push(
    "--mount",
    "type=bind,src=" + stageWork + ",target=/work",
    "--mount",
    "type=bind,src=" +
      path.join(destination, "bundle") +
      ",target=/bundle,readonly",
    "--mount",
    "type=bind,src=" +
      path.join(destination, "controls") +
      ",target=/controls,readonly",
    "--env",
    "npm_config_cache=/work/npm-cache",
  );
  if (kind === "caller-preflight") {
    assert.equal(selector, "root-readable");
    args.push(
      "--mount",
      "type=bind,src=" +
        path.join(destination, "work/evidence/caller-preflight") +
        ",target=/probe",
      "--cap-drop=ALL",
      "--cap-add=DAC_OVERRIDE",
      "--security-opt=no-new-privileges",
      "--entrypoint",
      "/usr/bin/python3.11",
      "--workdir",
      "/",
      catalog.image,
      "-I",
      "-S",
      "-B",
      "-c",
      callerPreflight,
    );
  } else if (metadata) {
    assert.ok(["preflight", "prepare", "observe"].includes(selector));
    assert.ok(
      Number.isFinite(bindings.grantSeconds) &&
        bindings.grantSeconds > 0 &&
        bindings.grantSeconds <= 7200,
    );
    args.push(
      "--cap-drop=ALL",
      "--cap-add=DAC_OVERRIDE",
      "--security-opt=no-new-privileges",
      "--entrypoint",
      "/usr/bin/python3.11",
      "--workdir",
      "/",
      catalog.image,
      "-I",
      "-S",
      "-B",
      "/controls/node-original-worker.py",
      selector,
      String(bindings.grantSeconds),
    );
  } else if (kind === "original") {
    const selected = nodeOriginalCommand(selector);
    const executable =
      selector === "configure"
        ? "/work/" + catalog.source.root + "/configure"
        : "/usr/bin/make";
    args.push(
      "--entrypoint",
      executable,
      "--workdir",
      "/work/" + catalog.source.root,
      catalog.image,
      ...selected.argv.slice(1),
    );
  } else {
    assert.equal(kind, "cache-preparation");
    const command = nodeOriginalCacheCommand(selector);
    args.push(
      "--entrypoint",
      command[0],
      "--workdir",
      "/work/" + catalog.source.root,
      catalog.image,
      ...command.slice(1),
    );
  }
  return args;
}

export async function runNodeOriginal(plan, startupFile) {
  assert.equal(
    process.platform,
    "linux",
    "Hosted original Node observation requires a Linux operator",
  );
  assert.equal(process.arch, "x64");
  assert.equal(os.machine(), "x86_64");
  requireNodeOriginalCatalog(plan.catalog);
  const caller = captureCProducerCallerIdentity();
  const startup = JSON.parse(
    await boundedBytes(path.resolve(startupFile), 2 * 1024 ** 2, caller),
  );
  assert.equal(startup.schemaVersion, 1);
  assert.equal(startup.scope, "fresh-original-node-source-operator-startup");
  assert.deepEqual(startup.caller, caller);
  assert.deepEqual(startup.source, await captureNodeOriginalSource());
  assert.deepEqual(startup.ci, ciContext());
  assert.ok(
    Date.now() - Date.parse(startup.createdAt) >= 0 &&
      Date.now() - Date.parse(startup.createdAt) <= 300000,
    "Stale operator startup refused",
  );
  const began = performance.now(),
    workDeadline = began + 7200000,
    finalDeadline = began + 7500000;
  const remaining = () => {
    const value = Math.floor(workDeadline - performance.now());
    assert.ok(value > 0, "Original Node shared work window exhausted");
    return value;
  };
  await caseSensitiveParent(plan.parent);
  const dockerPath = await realpath(
    (
      await exec("which", ["docker"], {
        env: environment,
        timeout: 5000,
        maxBuffer: 4096,
      })
    ).stdout.trim(),
  );
  const docker = (args) =>
    exec(dockerPath, args, {
      env: environment,
      timeout: 15000,
      maxBuffer: 2 * 1024 ** 2,
    });
  const server = JSON.parse(
    (await docker(["info", "--format", "{{json .}}"])).stdout,
  );
  assert.equal(server.OSType, "linux");
  assert.ok(
    server.NCPU >= 4 && server.MemTotal >= plan.catalog.limits.memoryBytes,
    "Selected Node capacity unavailable",
  );
  const image = validateObservedImage(
    JSON.parse(
      (await docker(["image", "inspect", plan.catalog.image])).stdout,
    )[0],
    plan.imageIdentity,
  );
  const free = await statfs(plan.parent, { bigint: true });
  assert.ok(
    free.bavail * free.bsize >=
      BigInt(plan.catalog.limits.observedWorkBytes) + 1024n ** 3n,
    "Declared owned Node work/free reserve unavailable",
  );
  await mkdir(plan.destination, { mode: 0o700 });
  const work = path.join(plan.destination, "work"),
    bundle = path.join(plan.destination, "bundle"),
    controlRoot = path.join(plan.destination, "controls");
  const stageWork = path.join(work, "node"),
    evidence = path.join(work, "evidence");
  for (const directory of [
    work,
    bundle,
    controlRoot,
    stageWork,
    evidence,
    path.join(evidence, "caller-preflight"),
    path.join(bundle, "source"),
    path.join(bundle, "docs"),
  ])
    await mkdir(directory, { mode: 0o700 });
  const state = {
    schemaVersion: 1,
    state: "original-node-preparing",
    source: startup.source,
    caller,
    ci: startup.ci,
    selectedProfile: plan.catalog.profile,
    catalogSha256: nodeOriginalCatalogSha256,
    startedAt: new Date().toISOString(),
    resources: plan.catalog.limits,
    networkPolicy: nodeOriginalNetworkPolicy,
    image,
    serverCapacity: {
      cpus: server.NCPU,
      memoryBytes: server.MemTotal,
      freeBytes: String(free.bavail * free.bsize),
    },
    nativeFilesystemQuotaEnforced: false,
    hardwareHostAttestationPerformed: false,
    executions: [],
    rawBytes: 0,
    originalStages: Object.fromEntries(
      plan.catalog.originalCommands.map((row) => [
        row.id,
        {
          invoked: false,
          terminalObserved: false,
          unrunReason: "prerequisites-not-completed",
        },
      ]),
    ),
    cleanupFailures: [],
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    publishedBinaryEqualityVerified: false,
    gateAComplete: false,
  };
  const active = new Map(),
    abort = new AbortController();
  const cutoff = setTimeout(
    () => abort.abort("shared-original-node-work-deadline"),
    Math.max(1, Math.floor(workDeadline - performance.now())),
  );
  const onSignal = () => abort.abort("caller-signal");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const save = () => atomicReceipt(plan.destination, state);
  let observer,
    interval,
    measuring,
    primary,
    outputs,
    builtNode,
    builtNodeRetained,
    finalSourceAndImageVerified = false;
  const measure = async () => {
    if (measuring) return measuring;
    measuring = observer
      .sample()
      .then((sample) => {
        const allowance =
          plan.inputRows.reduce((sum, row) => sum + row.bytes, 0) + 1024 ** 2;
        assert.ok(
          sample.bytes <= plan.catalog.limits.observedWorkBytes + allowance,
          "Node observed work envelope exceeded",
        );
        state.lastRetention = sample;
        return sample;
      })
      .finally(() => {
        measuring = null;
      });
    return measuring;
  };
  const execute = async (kind, selector) => {
    assert.ok(!abort.signal.aborted);
    remaining();
    const attempt = randomUUID(),
      cid = path.join(plan.destination, attempt + ".cid");
    const args = nodeOriginalArguments(kind, selector, {
      attempt,
      cid,
      stageWork,
      destination: plan.destination,
      grantSeconds: remaining() / 1000,
    });
    const spec = nodeContainerSpec(
      args,
      plan.pinnedImageConfig,
      image.id,
      kind,
    );
    requireNodeOriginalEnvironment(spec.env);
    const custody = await captureGoMountCustody(spec.mounts);
    const row = {
      kind,
      selector,
      attempt,
      argv: args,
      mountCustody: custody,
      physicalCommands: [],
      cleanup: null,
      secondaries: [],
    };
    state.executions.push(row);
    active.set(attempt, cid);
    await save();
    const cleanup = async () => {
      try {
        row.cleanup = await cleanupContainer(cid, attempt);
        active.delete(attempt);
      } catch (error) {
        row.secondaries.push(failure(error));
        throw error;
      } finally {
        try {
          await save();
        } catch (error) {
          row.secondaries.push(failure(error));
        }
      }
    };
    const invoke = async (
      operation,
      argv,
      milliseconds,
      cleanupObservation = false,
    ) => {
      const deadline = cleanupObservation ? finalDeadline : workDeadline;
      const limit = Math.min(
        Math.floor(deadline - performance.now()),
        Math.floor(milliseconds),
      );
      assert.ok(limit > 0);
      const relative = "evidence/" + randomUUID() + ".log",
        file = path.join(work, relative);
      const physical = {
        operation,
        argv,
        timeoutMs: limit,
        cleanupObservation,
      };
      row.physicalCommands.push(physical);
      await save();
      const maxBytes = Math.min(
        operation === "start-attached" &&
          ["original", "cache-preparation"].includes(kind)
          ? 256 * 1024 ** 2
          : 2 * 1024 ** 2,
        256 * 1024 ** 2 - state.rawBytes,
      );
      assert.ok(
        maxBytes > 0,
        "Original Node aggregate raw-log budget exhausted",
      );
      let terminal, primary;
      try {
        terminal = await observeForeground(
          () =>
            spawn(dockerPath, argv, {
              env: environment,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          file,
          {
            timeoutMs: limit,
            maxBytes,
            signal: cleanupObservation
              ? new AbortController().signal
              : abort.signal,
            stop: cleanup,
          },
        );
        physical.terminal = terminal;
      } catch (error) {
        primary = error;
        physical.failure = failure(error);
        physical.observedTerminal = error?.observedTerminal ?? null;
      }
      try {
        const rawPin = await identifyFile(file, maxBytes);
        physical.raw = { file: relative, ...rawPin };
        state.rawBytes += rawPin.bytes;
      } catch (error) {
        physical.rawRetentionFailure = failure(error);
        primary = combineNodeOriginalFailure(primary, error);
      }
      try {
        await save();
      } catch (error) {
        primary = combineNodeOriginalFailure(primary, error);
      }
      if (primary) throw primary;
      const needsText =
        operation !== "start-attached" ||
        kind === "metadata" ||
        kind === "caller-preflight";
      return {
        terminal,
        raw: physical.raw,
        ...(needsText
          ? {
              text: (
                await boundedBytes(
                  file,
                  Math.min(maxBytes, 2 * 1024 ** 2),
                  caller,
                )
              ).toString("utf8"),
            }
          : {}),
      };
    };
    const answer = await runNodeContainerTransport({
      args,
      spec,
      custody: async () => {
        assert.deepEqual(await captureGoMountCustody(spec.mounts), custody);
      },
      invoke,
      cleanup,
      record: async (value) => {
        (row.transport ??= []).push(value);
        await save();
      },
      now: () => performance.now(),
      deadline: workDeadline,
    });
    row.terminal = answer.terminal;
    row.nativeState = answer.nativeState;
    await save();
    return { row, ...answer };
  };
  const metadata = async (mode) => {
    const result = await execute("metadata", mode);
    assert.ok(successful(result.terminal));
    const value = JSON.parse(result.text);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.mode, mode);
    assert.equal(value.catalogSha256, nodeOriginalCatalogSha256);
    inspectNodeImageTools(value.imageTools);
    inspectNodePythonSelection(value.pythonCandidates);
    return value;
  };
  try {
    for (const row of plan.inputRows)
      await copyPinnedInput(
        path.join(plan.source, row.file),
        path.join(bundle, row.file),
        row,
      );
    await validateInputs(bundle, plan.inputRows);
    for (const [source, target] of controls) {
      const input = path.join(
        repository,
        "scripts/producer-qualification",
        source,
      );
      await copyPinnedInput(
        input,
        path.join(controlRoot, target),
        await identifyFile(input, 131072),
      );
    }
    state.retentionAttempt = randomUUID();
    observer = await startRetentionObserver({
      destination: plan.destination,
      image: plan.catalog.image,
      platform: "linux/amd64",
      attempt: state.retentionAttempt,
      environment,
      onFailure: (error) => abort.abort(String(error)),
    });
    await measure();
    interval = setInterval(() => {
      void measure().catch((error) => abort.abort(String(error)));
    }, 15000);
    const callerResult = await execute("caller-preflight", "root-readable");
    assert.ok(successful(callerResult.terminal));
    const callerObservation = JSON.parse(callerResult.text);
    assert.deepEqual(
      [
        callerObservation.schemaVersion,
        callerObservation.state,
        callerObservation.nativeUid,
        callerObservation.nativeGid,
        callerObservation.nativeMode,
        callerObservation.originalSourceOrCompilerExecuted,
      ],
      [1, "synthetic-root-export-readable", 0, 0, 0o644, false],
    );
    const probeFile = path.join(evidence, "caller-preflight/root-readable.bin");
    assert.deepEqual(await identifyFile(probeFile, 65536), {
      bytes: callerObservation.bytes,
      sha256: callerObservation.sha256,
    });
    state.callerExportReadability = {
      nativeObservation: callerObservation,
      actualCaller: caller,
      hostPhysicalOwner: {
        uid: (await lstat(probeFile)).uid,
        gid: (await lstat(probeFile)).gid,
      },
      targetContentsWereReadByActualNonrootCaller: true,
      rootToHostOwnerMappingInferred: false,
    };
    const preflight = await metadata("preflight");
    state.initialTools = preflight;
    const prepared = await metadata("prepare");
    assert.equal(prepared.coldSourceDocLockBound, true);
    state.preparedSource = prepared;
    for (const id of ["configure", "build"]) {
      const result = await execute("original", id);
      state.originalStages[id] = {
        invoked: true,
        terminalObserved: true,
        ...result.terminal,
        nativeStateObserved: true,
        raw: result.raw,
      };
      await save();
      if (!successful(result.terminal))
        throw Error("Original Node " + id + " did not succeed");
      const observed = await metadata("observe");
      assert.deepEqual(observed.imageTools, preflight.imageTools);
      outputs = observed.selectedOutputs;
    }
    const binary = outputs.find((row) => row.file === "out/Release/node");
    assert.equal(
      binary?.state,
      "retained-identity",
      "Fresh original Node binary is absent",
    );
    state.beforeTestOutputs = outputs;
    builtNode = binary;
    const retainedBuiltNode = path.join(
      plan.destination,
      "exports-built/out/Release/node",
    );
    await mkdir(path.dirname(retainedBuiltNode), {
      recursive: true,
      mode: 0o700,
    });
    await copyPinnedInput(
      path.join(stageWork, plan.catalog.source.root, binary.file),
      retainedBuiltNode,
      binary,
    );
    assert.deepEqual(
      await identifyFile(
        retainedBuiltNode,
        plan.catalog.limits.observedWorkBytes,
      ),
      { bytes: binary.bytes, sha256: binary.sha256 },
    );
    const retainedOwner = await lstat(retainedBuiltNode);
    assert.deepEqual(
      [retainedOwner.uid, retainedOwner.gid, retainedOwner.mode & 0o7777],
      [caller.uid, caller.gid, 0o600],
    );
    builtNodeRetained = {
      file: "exports-built/out/Release/node",
      bytes: binary.bytes,
      sha256: binary.sha256,
      originalModeObservedByWorker: binary.mode,
      operatorCopyOwner: caller,
      copiedOwnerRelabeledAsNative: false,
    };
    state.originalBuiltNodeBeforeTests = builtNodeRetained;
    for (const artifact of plan.catalog.docCache.artifacts) {
      const result = await execute("cache-preparation", artifact.id);
      assert.ok(
        successful(result.terminal),
        "Original bundled npm local archive cache preparation failed",
      );
    }
    const result = await execute("original", "upstream-tests");
    state.originalStages["upstream-tests"] = {
      invoked: true,
      terminalObserved: true,
      ...result.terminal,
      nativeStateObserved: true,
      raw: result.raw,
    };
    const observed = await metadata("observe");
    assert.deepEqual(observed.imageTools, preflight.imageTools);
    outputs = observed.selectedOutputs;
    state.state = "original-node-build-and-test-command-observed";
  } catch (error) {
    primary = error;
    state.primary = failure(error);
    state.state = "original-node-observation-incomplete";
  } finally {
    clearTimeout(cutoff);
    clearInterval(interval);
    if (measuring) {
      try {
        await measuring;
      } catch (error) {
        state.cleanupFailures.push(failure(error));
        primary = combineNodeOriginalFailure(primary, error);
      }
    }
    if (observer) {
      try {
        state.retentionObserver = await observer.close();
        state.retentionObserverReplayed = reconcileNodeRetention(
          await boundedBytes(
            path.join(plan.destination, "retention-observer.jsonl"),
            16 * 1024 ** 2,
          ),
          state.retentionObserver,
        );
      } catch (error) {
        state.cleanupFailures.push(failure(error));
        primary = combineNodeOriginalFailure(primary, error);
      }
      try {
        state.retentionCleanup = await cleanupContainer(
          path.join(plan.destination, "retention-observer.id"),
          state.retentionAttempt,
          "retention",
        );
      } catch (error) {
        state.cleanupFailures.push(failure(error));
        primary = combineNodeOriginalFailure(primary, error);
      }
    }
    for (const [attempt, cid] of active) {
      try {
        await cleanupContainer(cid, attempt);
        active.delete(attempt);
      } catch (error) {
        state.cleanupFailures.push(failure(error));
        primary = combineNodeOriginalFailure(primary, error);
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    state.selectedOutputs = outputs ?? [];
    state.elapsedSeconds = (performance.now() - began) / 1000;
    let outputCustodyVerified = false;
    try {
      assert.ok(
        performance.now() < finalDeadline,
        "Node finalization reserve exhausted before output retention",
      );
      const exports = path.join(plan.destination, "exports");
      await mkdir(exports, { mode: 0o700 });
      state.retainedOutputs = [];
      for (const row of state.selectedOutputs) {
        assert.ok(
          plan.catalog.selectedOutputs.includes(row.file),
          "Foreign Node output observation",
        );
        if (row.state !== "retained-identity") continue;
        const target = path.join(exports, row.file);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const original = path.join(
          stageWork,
          plan.catalog.source.root,
          row.file,
        );
        await copyPinnedInput(original, target, row);
        const actual = await identifyFile(
          target,
          plan.catalog.limits.observedWorkBytes,
        );
        assert.deepEqual(actual, { bytes: row.bytes, sha256: row.sha256 });
        const copied = await lstat(target);
        assert.deepEqual(
          [copied.uid, copied.gid, copied.mode & 0o7777],
          [caller.uid, caller.gid, 0o600],
        );
        state.retainedOutputs.push({
          file: "exports/" + row.file,
          ...actual,
          operatorCopyOwner: { uid: copied.uid, gid: copied.gid, mode: 0o600 },
          originalModeObservedByWorker: row.mode,
          copiedOwnerRelabeledAsNative: false,
        });
      }
      outputCustodyVerified = state.retainedOutputs.some(
        (row) => row.file === "exports/out/Release/node",
      );
      await validateInputs(bundle, plan.inputRows);
      assert.deepEqual(
        await captureNodeOriginalSource(),
        startup.source,
        "Node controller source changed during observation",
      );
      validateObservedImage(
        JSON.parse(
          (await docker(["image", "inspect", plan.catalog.image])).stdout,
        )[0],
        plan.imageIdentity,
      );
      finalSourceAndImageVerified = true;
      assert.ok(
        performance.now() < finalDeadline,
        "Node output/source retention exceeded finalization reserve",
      );
    } catch (error) {
      state.cleanupFailures.push(failure(error));
      primary = combineNodeOriginalFailure(primary, error);
    }
    state.completion = classifyNodeOriginalCompletion(
      state.originalStages,
      builtNode ?? outputs?.find((row) => row.file === "out/Release/node"),
      {
        coldSourceMatched:
          state.preparedSource?.coldSourceDocLockBound === true,
        imageAndToolsStable: finalSourceAndImageVerified,
        outputCustodyVerified:
          Boolean(builtNodeRetained) || outputCustodyVerified,
      },
    );
    state.originalTestGroups = plan.catalog.originalTargetOrder.map(
      (target) => ({
        target,
        state: state.originalStages["upstream-tests"].invoked
          ? "retain-original-raw-output-for-outcome-reconciliation"
          : "not-invoked",
        allOutcomesPassingClaimed: false,
      }),
    );
    state.completeSourceCompilerSdkAndNoticeClosureVerified = false;
    state.ownedClientsAndContainersCleaned =
      active.size === 0 &&
      state.retentionCleanup != null &&
      state.cleanupFailures.length === 0;
    state.elapsedSeconds = (performance.now() - began) / 1000;
    if (performance.now() >= finalDeadline)
      primary = combineNodeOriginalFailure(
        primary,
        Error("Original Node finalization clock exhausted"),
      );
    if (primary) {
      state.primary = failure(primary);
      state.state = "original-node-observation-incomplete";
    }
    try {
      await save();
    } catch (error) {
      primary = combineNodeOriginalFailure(primary, error);
    }
    if (performance.now() >= finalDeadline)
      primary = combineNodeOriginalFailure(
        primary,
        Error("Original Node final receipt exceeded finalization clock"),
      );
  }
  if (primary) throw Object.assign(primary, { nodeOriginalReceipt: state });
  return state;
}

export async function mainNodeOriginal(args) {
  if (args[0] === "capture-startup") {
    assert.equal(args.length, 2);
    return captureNodeOriginalStartup(args[1]);
  }
  if (args[0] === "verify-observation") {
    assert.equal(args.length, 4);
    const receipt = JSON.parse(
      await boundedBytes(path.resolve(args[1]), 16 * 1024 ** 2),
    );
    const startup = JSON.parse(
      await boundedBytes(path.resolve(args[2]), 2 * 1024 ** 2),
    );
    const observed = inspectNodeOriginalObservation(receipt, startup, args[3]);
    assert.deepEqual(await captureNodeOriginalSource(), startup.source);
    return observed;
  }
  assert.equal(args[0], "run");
  assert.equal(args.length, 7);
  assert.deepEqual(
    args.slice(5),
    ["--operator-trust-execution", "--coordinated-heavy-slot"],
    "Original upstream execution requires explicit operator and heavy-slot admission",
  );
  return runNodeOriginal(
    await prepareNodeOriginal(args[1], args[2], args[3]),
    args[4],
  );
}
export function inspectNodeOriginalObservation(
  receipt,
  startup,
  controllerExit,
) {
  assert.equal(
    controllerExit,
    "2",
    "The operator controller's scoped exit was not observed",
  );
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.catalogSha256, nodeOriginalCatalogSha256);
  assert.equal(receipt.state, "original-node-build-and-test-command-observed");
  assert.deepEqual(receipt.source, startup.source);
  assert.deepEqual(receipt.caller, startup.caller);
  assert.deepEqual(receipt.ci, startup.ci);
  assert.deepEqual(receipt.networkPolicy, nodeOriginalNetworkPolicy);
  assert.equal(receipt.ownedClientsAndContainersCleaned, true);
  assert.deepEqual(receipt.cleanupFailures, []);
  assert.ok(!Object.hasOwn(receipt, "primary"));
  assert.ok(
    Number.isSafeInteger(receipt.rawBytes) &&
      receipt.rawBytes >= 0 &&
      receipt.rawBytes <= nodeOriginalCatalog().limits.rawOutputBytes,
  );
  assert.ok(
    Number.isFinite(receipt.elapsedSeconds) &&
      receipt.elapsedSeconds > 0 &&
      receipt.elapsedSeconds < 7500,
  );
  assert.equal(
    receipt.completion.selectedOriginalNodeBuildCompletionVerified,
    true,
  );
  assert.equal(receipt.completion.originalTestCommandCompleted, true);
  assert.equal(receipt.completion.allUpstreamTestsPassed, false);
  assert.equal(receipt.completeOriginalNoticeClosureVerified, false);
  assert.equal(receipt.gateAComplete, false);
  const original = receipt.executions.filter((row) => row.kind === "original");
  assert.deepEqual(
    original.map((row) => row.selector),
    ["configure", "build", "upstream-tests"],
  );
  for (const row of original) {
    assert.equal(
      row.cleanup?.state === "removed" || row.cleanup?.state === "absent",
      true,
    );
    assert.deepEqual(row.secondaries, []);
    assert.equal(row.nativeState.Status, "exited");
    assert.equal(row.nativeState.Running, false);
    assert.equal(row.nativeState.ExitCode, row.terminal.exitCode);
    assert.equal(row.nativeState.OOMKilled, false);
    assert.equal(row.nativeState.Error, "");
    assert.ok(
      receipt.originalStages[row.selector].terminalObserved &&
        receipt.originalStages[row.selector].invoked,
    );
    assert.equal(
      receipt.originalStages[row.selector].exitCode,
      row.terminal.exitCode,
    );
  }
  return {
    state: "selected-original-node-build-and-original-test-command-recorded",
    originalCommandExitCodes: original.map((row) => ({
      stage: row.selector,
      exitCode: row.terminal.exitCode,
    })),
    allUpstreamTestsPassed: false,
    fullCompilerSdkBootstrapClosureVerified: false,
    completeOriginalNoticeClosureVerified: false,
    gateAComplete: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  mainNodeOriginal(process.argv.slice(2))
    .then((value) => {
      console.log(
        JSON.stringify({
          state: value.state ?? "node-original-startup-captured",
          gateAComplete: false,
        }),
      );
      process.exitCode =
        value.state === "original-node-build-and-test-command-observed" ? 2 : 0;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          state: "node-original-observation-refused",
          error: failure(error),
          gateAComplete: false,
        }),
      );
      process.exitCode = 1;
    });
}
