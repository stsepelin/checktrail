// Development-only operator utility; never invoked by discovery, CLI review or MCP.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import os from "node:os";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readFile,
  lstat,
  realpath,
  mkdir,
  writeFile,
  readdir,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { boundedProcess } from "./web-runtime-worker.mjs";

import {
  inspectLocalIdentity,
  verifyLocalIdentity,
  verifyObservedImage,
} from "./web-runtime-image.mjs";
export {
  verifyLocalIdentity,
  verifyObservedImage,
} from "./web-runtime-image.mjs";

export const LIMITS = Object.freeze({
  cpus: 2,
  memoryBytes: 4294967296,
  wallMs: 1200000,
  cleanupReserveMs: 20000,
  streamBytes: 4194304,
  outputFileBytes: 16777216,
});
const frozen = JSON.parse(
  await readFile(new URL("./web-runtime.v1.json", import.meta.url), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const image = (value) =>
  typeof value === "string" &&
  /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) =>
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
export function relativeInput(value) {
  assert.ok(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\\\0:]/.test(value),
  );
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
  return value;
}
export async function identify(filename, maximum = 536870912) {
  assert.ok(path.isAbsolute(filename));
  assert.equal(await realpath(filename), filename, "Input path crosses a link");
  const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await fd.stat({ bigint: true });
    assert.ok(
      before.isFile() && before.size >= 0n && before.size <= BigInt(maximum),
    );
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(1048576);
    let bytes = 0;
    while (true) {
      const next = await fd.read(
        buffer,
        0,
        Math.min(buffer.length, maximum + 1 - bytes),
        null,
      );
      if (!next.bytesRead) break;
      bytes += next.bytesRead;
      assert.ok(bytes <= maximum);
      digest.update(buffer.subarray(0, next.bytesRead));
    }
    const after = await fd.stat({ bigint: true }),
      linked = await lstat(filename, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(before[key], after[key]);
    assert.equal(linked.ino, after.ino);
    assert.equal(linked.dev, after.dev);
    assert.equal(BigInt(bytes), after.size);
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await fd.close();
  }
}
export function validateArtifacts(rows, expected = frozen.artifacts) {
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, expected.length);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  return expected.map((pin) => {
    const row = rows.find((value) => value.id === pin.id);
    assert.ok(row);
    exactKeys(row, ["id", "url", "file", "bytes", "sha256"]);
    assert.equal(row.url, pin.url);
    assert.equal(row.bytes, pin.bytes);
    assert.equal(row.sha256, pin.sha256);
    assert.ok(path.isAbsolute(row.file));
    return row;
  });
}
export function originalRecipe(kind) {
  assert.ok(kind === "github" || kind === "npm");
  const stage = (id, args, cjs = null) => ({
    id,
    executable: "npm",
    args,
    cwd: "lib/binding_web",
    cjs,
  });
  const esm = [
    stage("esm-release", ["run", "build"]),
    stage("esm-debug", ["run", "build:debug"]),
  ];
  const cjs = [
    stage("cjs-release", ["run", "build"], "true"),
    stage("cjs-debug", ["run", "build:debug"], "true"),
  ];
  return [
    stage("locked-install", ["ci"]),
    ...(kind === "github"
      ? [...cjs, ...esm]
      : [...esm, ...cjs, stage("declarations", ["run", "build:dts"])]),
  ];
}
export function inspectRuntime(value) {
  assert.ok(value.kind === "registry" || value.kind === "local-derived");
  exactKeys(value, [
    "kind",
    ...(value.kind === "registry"
      ? ["imageRef", "manifest", "config"]
      : ["local"]),
    "imageId",
    "platform",
    "nodeVersion",
    "npmVersion",
    "rustVersion",
    "tools",
  ]);
  if (value.kind === "registry") assert.ok(image(value.imageRef));
  else inspectLocalIdentity(value.local);
  assert.match(value.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(value.platform, "linux/amd64");
  assert.match(value.nodeVersion, /^24\.\d+\.\d+$/);
  assert.match(value.npmVersion, /^\d+\.\d+\.\d+$/);
  assert.match(value.rustVersion, /^1\.\d+\.\d+$/);
  assert.ok(Number(value.rustVersion.split(".")[1]) >= 90);
  for (const [row, digest] of value.kind === "registry"
    ? [
        [value.manifest, value.imageRef.split("@sha256:")[1]],
        [value.config, value.imageId.slice(7)],
      ]
    : []) {
    exactKeys(row, ["file", "bytes", "sha256"]);
    assert.equal(row.sha256, digest);
    assert.ok(path.isAbsolute(row.file));
    assert.ok(
      Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 1048576,
    );
  }
  assert.deepEqual(value.tools.map((row) => row.id).sort(), [
    "cargo",
    "git",
    "node",
    "npm",
    "python",
    "rustc",
    "tar",
  ]);
  for (const row of value.tools) {
    exactKeys(row, ["id", "file", "bytes", "sha256"]);
    assert.ok(path.posix.isAbsolute(row.file) && !/[\0:]/.test(row.file));
    assert.ok(
      Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        row.bytes <= 536870912 &&
        sha(row.sha256),
    );
  }
  return value;
}
export function inspectCache(value) {
  exactKeys(value, ["directory", "files", "manifestSha256"]);
  assert.ok(path.isAbsolute(value.directory));
  assert.ok(
    Array.isArray(value.files) &&
      value.files.length > 0 &&
      value.files.length <= 100000,
  );
  let previous = "",
    bytes = 0;
  for (const file of value.files) {
    exactKeys(file, ["path", "bytes", "sha256"]);
    relativeInput(file.path);
    assert.ok(file.path > previous);
    previous = file.path;
    assert.ok(
      Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= 134217728 &&
        sha(file.sha256),
    );
    bytes += file.bytes;
    assert.ok(bytes <= 5368709120);
  }
  assert.equal(hash(JSON.stringify(value.files)), value.manifestSha256);
  return value;
}
export async function verifyCache(value) {
  inspectCache(value);
  assert.equal(await realpath(value.directory), value.directory);
  const actual = [];
  async function visit(directory) {
    const entry = await lstat(directory, { bigint: true });
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name),
        stat = await lstat(filename);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await visit(filename);
      else {
        assert.ok(stat.isFile() && actual.length < 100000);
        actual.push({
          path: path
            .relative(value.directory, filename)
            .split(path.sep)
            .join("/"),
          ...(await identify(filename, 134217728)),
        });
      }
    }
    const after = await lstat(directory, { bigint: true });
    for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"])
      assert.equal(entry[key], after[key]);
  }
  await visit(value.directory);
  actual.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(actual, value.files);
}
export async function prepare(config) {
  exactKeys(config, [
    "schemaVersion",
    "task",
    "recipe",
    "artifacts",
    "runtime",
    "offlineInputs",
  ]);
  assert.equal(config.schemaVersion, 1);
  assert.match(config.task, /^checktrail-runtime-controller-[a-z0-9-]+$/);
  const artifacts = validateArtifacts(config.artifacts),
    observations = [];
  for (const row of artifacts) {
    const actual = await identify(row.file);
    assert.deepEqual(actual, { bytes: row.bytes, sha256: row.sha256 });
    observations.push({ id: row.id, ...actual });
  }
  const missing = [];
  if (!config.runtime)
    missing.push(
      "Frozen Linuxx64 image manifest/config, actual outer Node24/npm/Rust and tool byte pins",
    );
  else {
    inspectRuntime(config.runtime);
    if (config.runtime.kind === "local-derived")
      await verifyLocalIdentity(config.runtime, identify);
    else {
      for (const row of [config.runtime.manifest, config.runtime.config])
        assert.deepEqual(await identify(row.file, 1048576), {
          bytes: row.bytes,
          sha256: row.sha256,
        });
      const manifest = JSON.parse(
          await readFile(config.runtime.manifest.file, "utf8"),
        ),
        imageConfig = JSON.parse(
          await readFile(config.runtime.config.file, "utf8"),
        );
      assert.equal(manifest.config.digest, config.runtime.imageId);
      assert.equal(imageConfig.os, "linux");
      assert.equal(imageConfig.architecture, "amd64");
      assert.ok(
        manifest.layers.length > 0 &&
          manifest.layers.length === imageConfig.rootfs.diff_ids.length,
      );
    }
  }
  if (!config.offlineInputs)
    missing.push("Complete frozen npm and Cargo cache inventories");
  else {
    exactKeys(config.offlineInputs, ["npm", "cargo"]);
    for (const cache of Object.values(config.offlineInputs)) {
      await verifyCache(cache);
    }
  }
  const stages = originalRecipe(config.recipe);
  const codeInputs = [];
  for (const name of [
    "web-runtime-controller.mjs",
    "web-runtime-worker.mjs",
    "web-runtime-image.mjs",
    "web-runtime.v1.json",
    "web-runtime-acquisition.v1.json",
    "web-runtime-inputs.mjs",
    "web-runtime-prepare.py",
    "web-runtime-npm-cache.mjs",
    "web-runtime-command-vectors.v1.json",
    "binutils-image-identity.mjs",
    "binutils-image-identity.v1.json",
  ])
    codeInputs.push({
      name,
      ...(await identify(
        fileURLToPath(new URL(name, import.meta.url)),
        1048576,
      )),
    });
  assert.equal(
    (
      await identify(
        fileURLToPath(
          new URL("./web-runtime-command-vectors.v1.json", import.meta.url),
        ),
        1048576,
      )
    ).sha256,
    frozen.commandVectorsSha256,
  );
  const result = {
    schemaVersion: 1,
    profile: "original-web-runtime-reproduction-v1",
    task: config.task,
    recipe: config.recipe,
    limits: LIMITS,
    sourceCommit: frozen.sourceCommit,
    sdkVersion: frozen.sdkVersion,
    artifactObservations: observations,
    codeInputs,
    originalCommandVectorsSha256: frozen.commandVectorsSha256,
    stages,
    expectedOutputs: frozen.expectedOutputs[config.recipe],
    readyForOperatorExecution: missing.length === 0,
    missingInputs: missing,
    imageLocallyObserved: false,
    originalBuildFlagsPreserved: true,
    addedUpstreamTests: [],
    publicationAttempted: false,
    nativeInvoked: false,
    runtimeBuildVerified: false,
    sdkProducerBuildClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
  return { ...result, planSha256: hash(JSON.stringify(result)) };
}
export function dockerArguments(
  config,
  paths,
  name,
  identity = { uid: process.getuid?.(), gid: process.getgid?.() },
) {
  inspectRuntime(config.runtime);
  assert.match(name, /^checktrail-runtime-[a-f0-9-]{36}$/);
  const args = [
    "run",
    "--pull",
    "never",
    "--rm",
    "--init",
    "--name",
    name,
    "--platform",
    "linux/amd64",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--pids-limit",
    "256",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--label",
    "checktrail.task=" + config.task,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=512m",
  ];
  for (const value of [identity.uid, identity.gid])
    assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 4294967294);
  args.push("--user", `${identity.uid}:${identity.gid}`);
  for (const [source, target, readonly] of [
    [paths.controller, "/controller", true],
    [paths.inputs, "/inputs", true],
    [config.offlineInputs.npm.directory, "/npm-cache", true],
    [config.offlineInputs.cargo.directory, "/cargo-cache", true],
    [paths.work, "/work", false],
    [paths.receipts, "/receipts", false],
  ]) {
    assert.ok(path.isAbsolute(source) && !/[\0,\n]/.test(source));
    args.push(
      "--mount",
      `type=bind,src=${source},target=${target}${readonly ? ",readonly" : ""}`,
    );
  }
  args.push(
    config.runtime.kind === "registry"
      ? config.runtime.imageRef
      : config.runtime.imageId,
    "node",
    "/controller/web-runtime-worker.mjs",
    "--operator-trust-execution",
    "/inputs/execution.json",
  );
  return args;
}
export async function compareOutputs(
  directory,
  recipe,
  expected = frozen.expectedOutputs[recipe],
) {
  assert.ok(expected);
  const actual = [];
  for (const row of expected) {
    relativeInput(row.path);
    const found = await identify(
      path.join(directory, row.path),
      LIMITS.outputFileBytes,
    );
    actual.push({ path: row.path, ...found });
  }
  return {
    files: actual,
    matchesPublishedBytes: actual.every(
      (row, index) =>
        row.bytes === expected[index].bytes &&
        row.sha256 === expected[index].sha256,
    ),
  };
}
export async function verifyOriginalSource(directory, reference = frozen) {
  const outputs = new Map(
    reference.preexistingProducerOutputs.map((row) => [row.sourcePath, row]),
  );
  const observed = [];
  for (const row of reference.originalSourceFiles) {
    const generated = outputs.get(row.path),
      expected = generated?.expected ?? row;
    const actual = await identify(
      path.join(directory, row.path),
      LIMITS.outputFileBytes,
    );
    assert.deepEqual(actual, {
      bytes: expected.bytes,
      sha256: expected.sha256,
    });
    observed.push({
      path: row.path,
      before: { bytes: row.bytes, sha256: row.sha256 },
      after: actual,
      kind: generated
        ? "source-derived-producer-output"
        : "unchanged-original-input",
    });
  }
  return {
    files: observed,
    originalInputsUnchanged: true,
    producerOutputTargets: reference.producerOutputTargets,
  };
}
export function completeProcessObservation(value) {
  return (
    value?.started === true &&
    value.terminalObserved === true &&
    value.exitCode === 0 &&
    value.signal === null &&
    value.timedOut === false &&
    value.interrupted !== true &&
    value.truncated === false &&
    value.spawnError === null &&
    value.storageFailure === null &&
    value.logAdmissionFailed === false &&
    !value.outputIdentityUnavailable &&
    !value.terminationError &&
    [value.stdout, value.stderr].every(
      (output) =>
        output &&
        Number.isSafeInteger(output.bytes) &&
        output.bytes >= 0 &&
        output.bytes <= LIMITS.streamBytes &&
        output.bytes === output.observedBytes &&
        sha(output.sha256),
    )
  );
}
export async function verifyImageObservation(runtime, attempt) {
  assert.equal(completeProcessObservation(attempt), true);
  const [observed, ...extras] = JSON.parse(
    await readFile(attempt.stdout.file, "utf8"),
  );
  assert.equal(extras.length, 0);
  verifyObservedImage(runtime, observed);
  return true;
}
export function qualification(receipt) {
  const expected = originalRecipe(receipt.recipe);
  assert.equal(receipt.nativeInvoked, true);
  assert.equal(receipt.cleanupComplete, true);
  assert.notEqual(receipt.interrupted, true);
  assert.equal(completeProcessObservation(receipt.dockerAttempt), true);
  assert.equal(receipt.immutableInputsRechecked, true);
  assert.equal(receipt.originalSourceRechecked, true);
  assert.equal(receipt.runtimeToolsRechecked, true);
  assert.equal(receipt.sdkToolsRechecked, true);
  validateNativeHost(receipt.host);
  assert.equal(receipt.imageReinspected, true);
  assert.equal(receipt.stages.length, expected.length);
  assert.ok(
    receipt.stages.every(
      (row, i) =>
        row.id === expected[i].id &&
        row.started &&
        row.terminalObserved &&
        row.exitCode === 0 &&
        row.signal === null &&
        !row.timedOut &&
        !row.truncated,
    ),
  );
  for (const [i, row] of receipt.stages.entries()) {
    assert.equal(completeProcessObservation(row), true);
    assert.equal(row.executable, expected[i].executable);
    assert.deepEqual(row.args, expected[i].args);
    assert.equal(row.cwd, expected[i].cwd);
    assert.equal(row.cjs, expected[i].cjs);
    for (const output of [row.stdout, row.stderr]) {
      assert.ok(
        Number.isSafeInteger(output.bytes) &&
          output.bytes >= 0 &&
          output.bytes <= LIMITS.streamBytes &&
          output.bytes === output.observedBytes &&
          sha(output.sha256),
      );
    }
  }
  assert.equal(receipt.outputs.matchesPublishedBytes, true);
  return {
    runtimeBuildVerified: true,
    sdkProducerBuildClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  };
}
export function validateNativeHost(value) {
  assert.equal(value.platform, "linux", "Native runtime requires Linux host");
  assert.equal(value.arch, "x64", "Native runtime requires x64 host");
  assert.equal(
    value.machine,
    "x86_64",
    "Native runtime requires x86_64 machine observation",
  );
  if (value.runnerOs !== null) assert.equal(value.runnerOs, "Linux");
  if (value.runnerArch !== null) assert.equal(value.runnerArch, "X64");
  assert.equal(value.hardwareAttestationPerformed, false);
  return value;
}
export const hostObservation = () => ({
  platform: process.platform,
  arch: process.arch,
  machine: os.machine(),
  runnerOs: process.env.RUNNER_OS ?? null,
  runnerArch: process.env.RUNNER_ARCH ?? null,
  hardwareAttestationPerformed: false,
});
export async function run(config, receiptDirectory, { signal } = {}) {
  const host = validateNativeHost(hostObservation());
  const plan = await prepare(config);
  assert.equal(
    plan.readyForOperatorExecution,
    true,
    "Missing frozen runtime inputs",
  );
  const started = performance.now(),
    deadline = started + LIMITS.wallMs;
  assert.ok(path.isAbsolute(receiptDirectory));
  await mkdir(receiptDirectory, { mode: 0o700 });
  const name = "checktrail-runtime-" + randomUUID(),
    inputs = path.join(receiptDirectory, "inputs"),
    work = path.join(receiptDirectory, "work"),
    harness = path.join(receiptDirectory, "controller-harness"),
    workerReceipts = path.join(receiptDirectory, "worker-receipts");
  await mkdir(inputs, { mode: 0o700 });
  await mkdir(work, { mode: 0o700 });
  await mkdir(harness, { mode: 0o700 });
  await mkdir(workerReceipts, { mode: 0o700 });
  for (const row of plan.codeInputs) {
    const target = path.join(harness, row.name);
    await copyFile(fileURLToPath(new URL(row.name, import.meta.url)), target);
    assert.deepEqual(await identify(target, 1048576), {
      bytes: row.bytes,
      sha256: row.sha256,
    });
  }
  const { link } = await import("node:fs/promises");
  const staged = [];
  for (const row of config.artifacts) {
    const filename = path.join(inputs, row.id + ".archive");
    await link(row.file, filename);
    staged.push({ ...row, file: "/inputs/" + row.id + ".archive" });
  }
  const workerConfig = {
    ...config,
    artifacts: staged,
    planSha256: plan.planSha256,
    expectedOutputs: plan.expectedOutputs,
  };
  await writeFile(
    path.join(inputs, "execution.json"),
    JSON.stringify(workerConfig),
    { mode: 0o600, flag: "wx" },
  );
  const receipt = {
    ...plan,
    host,
    nativeInvoked: false,
    cleanupComplete: false,
    dockerAttempt: null,
    cleanup: null,
  };
  try {
    const inspection = await boundedProcess(
      "docker",
      [
        "image",
        "inspect",
        config.runtime.kind === "registry"
          ? config.runtime.imageRef
          : config.runtime.imageId,
      ],
      {
        cwd: receiptDirectory,
        env: process.env,
        deadline: deadline - LIMITS.cleanupReserveMs,
        prefix: path.join(receiptDirectory, "image-inspect"),
        signal,
      },
    );
    await verifyImageObservation(config.runtime, inspection);
    receipt.imageLocallyObserved = true;
    receipt.dockerAttempt = await boundedProcess(
      "docker",
      dockerArguments(
        config,
        {
          controller: harness,
          inputs,
          work,
          receipts: workerReceipts,
        },
        name,
      ),
      {
        cwd: receiptDirectory,
        env: process.env,
        deadline: deadline - LIMITS.cleanupReserveMs,
        prefix: path.join(receiptDirectory, "docker-run"),
        signal,
      },
    );
  } catch (error) {
    receipt.error = String(error).slice(0, 2048);
  } finally {
    receipt.cleanup = await boundedProcess("docker", ["rm", "--force", name], {
      cwd: receiptDirectory,
      env: process.env,
      deadline,
      prefix: path.join(receiptDirectory, "cleanup"),
    });
    const remaining = await boundedProcess(
      "docker",
      ["ps", "--all", "--quiet", "--filter", "name=^/" + name + "$"],
      {
        cwd: receiptDirectory,
        env: process.env,
        deadline,
        prefix: path.join(receiptDirectory, "cleanup-observation"),
      },
    );
    receipt.cleanupComplete =
      completeProcessObservation(remaining) &&
      (await readFile(remaining.stdout.file, "utf8")).trim() === "";
    try {
      const worker = JSON.parse(
        await readFile(path.join(workerReceipts, "worker-result.json"), "utf8"),
      );
      assert.equal(worker.planSha256, plan.planSha256);
      receipt.nativeInvoked = worker.nativeInvoked;
      receipt.runtimeToolsRechecked = worker.runtimeToolsRechecked === true;
      receipt.sdkToolsRechecked = worker.sdkToolsRechecked === true;
      receipt.stages = worker.stages;
      for (const stage of receipt.stages)
        for (const stream of ["stdout", "stderr"]) {
          const output = stage[stream];
          if (!output) continue;
          assert.equal(output.name, `stage-${stage.id}.${stream}.log`);
          relativeInput(output.name);
          assert.deepEqual(
            await identify(
              path.join(workerReceipts, output.name),
              LIMITS.streamBytes,
            ),
            { bytes: output.bytes, sha256: output.sha256 },
          );
        }
      receipt.outputs = await compareOutputs(
        path.join(work, "source", "lib/binding_web"),
        config.recipe,
      );
      receipt.originalSource = await verifyOriginalSource(
        path.join(work, "source"),
      );
      receipt.originalSourceRechecked = true;
      const after = await prepare(config);
      assert.equal(after.planSha256, plan.planSha256);
      for (const row of plan.codeInputs)
        assert.deepEqual(
          await identify(path.join(harness, row.name), 1048576),
          { bytes: row.bytes, sha256: row.sha256 },
        );
      const finalInspection = await boundedProcess(
        "docker",
        ["image", "inspect", config.runtime.imageId],
        {
          cwd: receiptDirectory,
          env: process.env,
          deadline,
          prefix: path.join(receiptDirectory, "image-inspect-final"),
        },
      );
      await verifyImageObservation(config.runtime, finalInspection);
      receipt.imageReinspected = true;
      receipt.immutableInputsRechecked = true;
    } catch (error) {
      receipt.workerResultUnavailable = true;
      receipt.workerEvidenceError = String(error).slice(0, 2048);
    }
    receipt.durationMs = performance.now() - started;
    receipt.interrupted = signal?.aborted === true;
    try {
      Object.assign(receipt, qualification(receipt));
    } catch (error) {
      receipt.runtimeBuildVerified = false;
      receipt.incompleteReason = String(error).slice(0, 2048);
    }
    if (
      receipt.durationMs > LIMITS.wallMs ||
      !completeProcessObservation(receipt.dockerAttempt) ||
      receipt.error
    )
      receipt.runtimeBuildVerified = false;
    await writeFile(
      path.join(receiptDirectory, "result.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  }
  return receipt;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, input, output, ...flags] = process.argv.slice(2);
  assert.ok(mode === "prepare" || mode === "run");
  const config = JSON.parse(await readFile(input, "utf8"));
  if (mode === "prepare") {
    assert.equal(flags.length, 0);
    const result = await prepare(config);
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        readyForOperatorExecution: result.readyForOperatorExecution,
        nativeInvoked: false,
        missingInputs: result.missingInputs,
        planSha256: result.planSha256,
      }),
    );
  } else {
    assert.deepEqual(flags, [
      "--operator-trust-execution",
      "--coordinated-heavy-slot",
    ]);
    const cancellation = new globalThis.AbortController();
    const interrupt = () =>
      cancellation.abort(new Error("Operator process interrupted"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let result;
    try {
      result = await run(config, output, { signal: cancellation.signal });
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    console.log(
      JSON.stringify({
        runtimeBuildVerified: result.runtimeBuildVerified,
        nativeInvoked: result.nativeInvoked,
        cleanupComplete: result.cleanupComplete,
      }),
    );
    if (!result.runtimeBuildVerified) process.exitCode = 1;
  }
}
