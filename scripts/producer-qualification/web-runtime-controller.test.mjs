import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdtemp,
  realpath,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import {
  LIMITS,
  relativeInput,
  identify,
  validateArtifacts,
  originalRecipe,
  inspectRuntime,
  inspectCache,
  verifyCache,
  dockerArguments as actualDockerArguments,
  compareOutputs,
  qualification,
  prepare,
  completeProcessObservation,
  verifyOriginalSource,
  validateNativeHost,
} from "./web-runtime-controller.mjs";
import {
  boundedBytes,
  versionProbeMatches,
  runtimeVersionProbes,
  inspectResourceObservation,
  boundedProcess,
} from "./web-runtime-worker.mjs";
const dockerArguments = (config, paths, name) =>
  actualDockerArguments(config, paths, name, { uid: 1000, gid: 1000 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const frozen = JSON.parse(
  await readFile(new URL("./web-runtime.v1.json", import.meta.url), "utf8"),
);
const clone = (value) => JSON.parse(JSON.stringify(value));
const runtime = () => ({
  kind: "registry",
  imageRef: "docker.io/library/example@sha256:" + "a".repeat(64),
  imageId: "sha256:" + "b".repeat(64),
  platform: "linux/amd64",
  manifest: {
    file: "/synthetic/manifest.json",
    bytes: 1,
    sha256: "a".repeat(64),
  },
  config: { file: "/synthetic/config.json", bytes: 1, sha256: "b".repeat(64) },
  nodeVersion: "24.1.2",
  npmVersion: "11.1.2",
  rustVersion: "1.90.0",
  tools: ["cargo", "git", "node", "npm", "python", "rustc", "tar"].map(
    (id) => ({
      id,
      file: "/synthetic/bin/" + id,
      bytes: 1,
      sha256: "c".repeat(64),
    }),
  ),
});
const temp = async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "checktrail-runtime-pure-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const syntheticReceipt = () => ({
  recipe: "github",
  host: {
    platform: "linux",
    arch: "x64",
    machine: "x86_64",
    runnerOs: null,
    runnerArch: null,
    hardwareAttestationPerformed: false,
  },
  sdkToolsRechecked: true,
  nativeInvoked: true,
  cleanupComplete: true,
  immutableInputsRechecked: true,
  originalSourceRechecked: true,
  runtimeToolsRechecked: true,
  imageReinspected: true,
  dockerAttempt: {
    started: true,
    terminalObserved: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    spawnError: null,
    storageFailure: null,
    logAdmissionFailed: false,
    stdout: { bytes: 0, observedBytes: 0, sha256: hash("") },
    stderr: { bytes: 0, observedBytes: 0, sha256: hash("") },
  },
  outputs: { matchesPublishedBytes: true },
  stages: originalRecipe("github").map((row) => ({
    ...row,
    started: true,
    terminalObserved: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    spawnError: null,
    storageFailure: null,
    logAdmissionFailed: false,
    stdout: { bytes: 0, observedBytes: 0, sha256: hash("") },
    stderr: { bytes: 0, observedBytes: 0, sha256: hash("") },
  })),
});
test("all four log and journal targets admit transactionally before the actual Node producer", async (t) => {
  for (const suffix of [
    ".stdout.log",
    ".stderr.log",
    ".started.json",
    ".attempt.json",
  ]) {
    const directory = await temp(t),
      prefix = path.join(directory, "attempt"),
      marker = path.join(directory, "child-marker"),
      preexisting = prefix + suffix;
    await writeFile(preexisting, "preserve original bytes");
    let spawned = false;
    const result = await boundedProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import fs from "node:fs";fs.writeFileSync(process.argv[1],"child")',
        marker,
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        prefix,
        deadline: performance.now() + 3000,
        onSpawn: () => {
          spawned = true;
        },
      },
    );
    assert.equal(result.started, false);
    assert.equal(spawned, false);
    assert.equal(result.logAdmissionFailed, true);
    assert.match(result.storageFailure, /EEXIST/);
    assert.deepEqual(result.admissionRollbackErrors, []);
    assert.equal(
      await readFile(preexisting, "utf8"),
      "preserve original bytes",
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    for (const other of [
      ".stdout.log",
      ".stderr.log",
      ".started.json",
      ".attempt.json",
    ].filter((value) => value !== suffix))
      await assert.rejects(readFile(prefix + other), { code: "ENOENT" });
  }
});
test("fresh complete log family admits the actual synthetic Node process and retains exact output", async (t) => {
  const directory = await temp(t),
    prefix = path.join(directory, "attempt"),
    marker = path.join(directory, "child-marker");
  const result = await boundedProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import fs from "node:fs";process.stdout.write("stdout");process.stderr.write("stderr");fs.writeFileSync(process.argv[1],"child")',
      marker,
    ],
    {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin" },
      prefix,
      deadline: performance.now() + 3000,
    },
  );
  assert.equal(completeProcessObservation(result), true);
  assert.equal(await readFile(marker, "utf8"), "child");
  assert.equal(await readFile(prefix + ".stdout.log", "utf8"), "stdout");
  assert.equal(await readFile(prefix + ".stderr.log", "utf8"), "stderr");
  assert.equal(
    JSON.parse(await readFile(prefix + ".started.json", "utf8")).started,
    true,
  );
  assert.equal(
    JSON.parse(await readFile(prefix + ".attempt.json", "utf8")).exitCode,
    0,
  );
});
test(
  "later journal callback failure stays observed and stops the actual child group",
  {
    skip:
      process.platform === "win32"
        ? "POSIX group cancellation belongs to the Linux-only native controller"
        : false,
  },
  async (t) => {
    const directory = await temp(t),
      prefix = path.join(directory, "attempt"),
      marker = path.join(directory, "child-marker");
    const result = await boundedProcess(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import fs from "node:fs";setTimeout(()=>fs.writeFileSync(process.argv[1],"child"),2000)',
        marker,
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin" },
        prefix,
        deadline: performance.now() + 3000,
        onSpawn: () => {
          throw Error("synthetic journal callback failure");
        },
      },
    );
    assert.equal(result.started, true);
    assert.equal(result.terminalObserved, true);
    assert.match(result.storageFailure, /synthetic journal callback failure/);
    assert.equal(completeProcessObservation(result), false);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

test("original GitHub build recipe preserves all defaults and CJS order without upstream tests", () => {
  assert.deepEqual(
    originalRecipe("github").map((row) => [row.id, row.args, row.cjs]),
    [
      ["locked-install", ["ci"], null],
      ["cjs-release", ["run", "build"], "true"],
      ["cjs-debug", ["run", "build:debug"], "true"],
      ["esm-release", ["run", "build"], null],
      ["esm-debug", ["run", "build:debug"], null],
    ],
  );
});
test("original npm build recipe preserves ESM first and declarations without publication", () => {
  assert.deepEqual(
    originalRecipe("npm").map((row) => row.id),
    [
      "locked-install",
      "esm-release",
      "esm-debug",
      "cjs-release",
      "cjs-debug",
      "declarations",
    ],
  );
  assert.deepEqual(originalRecipe("npm").at(-1).args, ["run", "build:dts"]);
  assert.ok(
    originalRecipe("npm").every(
      (row) => !row.args.includes("test") && !row.args.includes("publish"),
    ),
  );
  assert.throws(() => originalRecipe("github-extra"));
  assert.throws(() => originalRecipe("npm:test"));
});
test("exact artifact identities reject duplicates omissions altered SHA and adjacent identifiers", () => {
  assert.equal(
    validateArtifacts(
      frozen.artifacts.map((row) => ({ ...row, file: "/synthetic/" + row.id })),
    ).length,
    12,
  );
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => (rows[1] = rows[0]),
    (rows) => (rows[0].id += "-extra"),
    (rows) => (rows[0].sha256 = "d".repeat(64)),
    (rows) => rows[0].bytes++,
    (rows) => (rows[0].url += "?changed"),
  ]) {
    const rows = frozen.artifacts.map((row) => ({
      ...row,
      file: "/synthetic/" + row.id,
    }));
    mutate(rows);
    assert.throws(() => validateArtifacts(rows));
  }
});
test("relative names enforce whole path boundaries and accept harmless embedded dots", () => {
  for (const value of [
    "",
    "/absolute",
    "../escape",
    "a/../b",
    "a//b",
    "a/./b",
    "a\\b",
    "a:b",
    "a\0b",
  ])
    assert.throws(() => relativeInput(value));
  for (const value of [
    "debug/web-tree-sitter.js",
    "a..b/file-name",
    ".well-known/file",
  ])
    assert.equal(relativeInput(value), value);
});
test("runtime pins require immutable Linuxx64 image actual versions and complete tool set", () => {
  inspectRuntime(runtime());
  for (const mutate of [
    (value) => (value.imageRef = "docker.io/library/example:latest"),
    (value) => (value.platform = "linux/arm64"),
    (value) => (value.nodeVersion = "240.1.2"),
    (value) => (value.nodeVersion = "22.16.0"),
    (value) => (value.rustVersion = "1.89.0"),
    (value) => value.tools.pop(),
    (value) => (value.config.sha256 = "e".repeat(64)),
  ]) {
    const value = runtime();
    mutate(value);
    assert.throws(() => inspectRuntime(value));
  }
  const newer = runtime();
  newer.nodeVersion = "24.2.3";
  newer.rustVersion = "1.91.0";
  inspectRuntime(newer);
});
test("fixed resource policy and container command cannot pull images or expand budgets", () => {
  assert.deepEqual(
    [LIMITS.cpus, LIMITS.memoryBytes, LIMITS.wallMs],
    [2, 4294967296, 1200000],
  );
  assert.throws(() => {
    LIMITS.cpus = 8;
  });
  const config = {
    task: "checktrail-runtime-controller-pure",
    runtime: runtime(),
    offlineInputs: {
      npm: { directory: "/synthetic/npm" },
      cargo: { directory: "/synthetic/cargo" },
    },
  };
  const args = dockerArguments(
    config,
    {
      controller: "/synthetic/controller",
      inputs: "/synthetic/inputs",
      work: "/synthetic/work",
      receipts: "/synthetic/receipts",
    },
    "checktrail-runtime-00000000-0000-0000-0000-000000000000",
  );
  for (const [flag, value] of [
    ["--pull", "never"],
    ["--platform", "linux/amd64"],
    ["--cpus", "2"],
    ["--memory", "4g"],
    ["--memory-swap", "4g"],
    ["--network", "none"],
  ])
    assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(
    args.includes("type=bind,src=/synthetic/inputs,target=/inputs,readonly"),
  );
  assert.throws(() =>
    dockerArguments(
      config,
      {
        controller: "/bad,path",
        inputs: "/synthetic/inputs",
        work: "/synthetic/work",
        receipts: "/synthetic/receipts",
      },
      "checktrail-runtime-00000000-0000-0000-0000-000000000000",
    ),
  );
});
test("cache inventory binds ordering exact hashes and every actual file including near-name extras", async (t) => {
  const directory = await temp(t);
  await writeFile(path.join(directory, "one"), "one");
  const files = [{ path: "one", bytes: 3, sha256: hash("one") }],
    value = { directory, files, manifestSha256: hash(JSON.stringify(files)) };
  inspectCache(value);
  await verifyCache(value);
  await writeFile(path.join(directory, "one-extra"), "extra");
  await assert.rejects(verifyCache(value));
  await rm(path.join(directory, "one-extra"));
  await writeFile(path.join(directory, "one"), "two");
  await assert.rejects(verifyCache(value));
  await writeFile(path.join(directory, "one"), "one");
  await verifyCache(value);
  const duplicate = clone(value);
  duplicate.files.push(clone(files[0]));
  duplicate.manifestSha256 = hash(JSON.stringify(duplicate.files));
  assert.throws(() => inspectCache(duplicate));
});
test("source and cache filesystem identities reject symlinks and bounded oversized inputs", async (t) => {
  const directory = await temp(t),
    file = path.join(directory, "file"),
    link = path.join(directory, "link");
  await writeFile(file, "bounded");
  await symlink(file, link);
  assert.deepEqual(await identify(file, 7), {
    bytes: 7,
    sha256: hash("bounded"),
  });
  await assert.rejects(identify(file, 6));
  await assert.rejects(identify(link));
  const files = [{ path: "file", bytes: 7, sha256: hash("bounded") }];
  await assert.rejects(
    verifyCache({
      directory,
      files,
      manifestSha256: hash(JSON.stringify(files)),
    }),
  );
});
test("bounded output preserves exact-boundary streams and marks all overflows incomplete", () => {
  const exact = boundedBytes([Buffer.from("ab"), Buffer.from("cd")], 4);
  assert.equal(exact.retained.toString(), "abcd");
  assert.equal(exact.truncated, false);
  const over = boundedBytes(
    [Buffer.from("ab"), Buffer.from("cde"), Buffer.from("f")],
    4,
  );
  assert.equal(over.retained.toString(), "abcd");
  assert.equal(over.observedBytes, 6);
  assert.equal(over.truncated, true);
  assert.equal(boundedBytes([], 4).truncated, false);
});
test("native version boundaries reject adjacent versions without rejecting original revision suffixes", () => {
  const prefix = "emcc compiler 4.0.15";
  assert.equal(
    versionProbeMatches("/sdk/emcc", prefix + " (revision)", prefix),
    true,
  );
  assert.equal(versionProbeMatches("/sdk/emcc", prefix, prefix), true);
  for (const suffix of ["0", "-extra", "x"])
    assert.equal(
      versionProbeMatches("/sdk/emcc", prefix + suffix, prefix),
      false,
    );
  assert.equal(versionProbeMatches("node", "v22.16.00", "v22.16.0"), false);
  assert.equal(
    versionProbeMatches("/sdk/notemcc", prefix + " (revision)", prefix),
    false,
  );
  assert.equal(
    versionProbeMatches("rustc", "rustc 1.90.00 extra", "rustc 1.90.0 "),
    false,
  );
});
test("actual resource observations require the exact selected CPU memory and PID bounds", () => {
  assert.deepEqual(
    inspectResourceObservation({
      cpuMax: "200000 100000\n",
      memoryMax: "4294967296\n",
      pidsMax: "256\n",
    }),
    { cpus: 2, memoryBytes: 4294967296, pids: 256 },
  );
  assert.equal(
    inspectResourceObservation({
      cpuMax: "100000 50000",
      memoryMax: "4294967296",
      pidsMax: "256",
    }).cpus,
    2,
  );
  for (const value of [
    { cpuMax: "max 100000", memoryMax: "4294967296", pidsMax: "256" },
    { cpuMax: "200001 100000", memoryMax: "4294967296", pidsMax: "256" },
    { cpuMax: "200000 100000", memoryMax: "4294967297", pidsMax: "256" },
    { cpuMax: "200000 100000", memoryMax: "4294967296", pidsMax: "257" },
  ])
    assert.throws(() => inspectResourceObservation(value));
});
test("synthetic stage validation rejects failure missing terminal truncation empty execution or cleanup", () => {
  assert.deepEqual(qualification(syntheticReceipt()), {
    runtimeBuildVerified: true,
    sdkProducerBuildClosureVerified: false,
    historicalPublisherConsumptionVerified: false,
    gateAComplete: false,
  });
  for (const mutate of [
    (row) => (row.nativeInvoked = false),
    (row) => (row.cleanupComplete = false),
    (row) => row.stages.pop(),
    (row) => (row.stages[0].started = false),
    (row) => (row.stages[0].terminalObserved = false),
    (row) => (row.stages[0].exitCode = 1),
    (row) => (row.stages[0].timedOut = true),
    (row) => (row.stages[0].truncated = true),
    (row) => row.stages[0].args.push("--ignore-scripts"),
    (row) => row.stages[0].stdout.observedBytes++,
    (row) => (row.outputs.matchesPublishedBytes = false),
  ]) {
    const row = syntheticReceipt();
    mutate(row);
    assert.throws(() => qualification(row));
  }
});
test("outer Docker zero exit cannot replace complete observation or final immutable checks", () => {
  const row = syntheticReceipt();
  assert.equal(completeProcessObservation(row.dockerAttempt), true);
  for (const [key, value] of [
    ["started", false],
    ["terminalObserved", false],
    ["timedOut", true],
    ["truncated", true],
    ["signal", "SIGTERM"],
    ["spawnError", "unavailable"],
    ["storageFailure", "EIO"],
    ["logAdmissionFailed", true],
    ["outputIdentityUnavailable", true],
    ["terminationError", "EPERM"],
  ]) {
    const changed = syntheticReceipt();
    changed.dockerAttempt[key] = value;
    assert.equal(changed.dockerAttempt.exitCode, 0);
    assert.equal(completeProcessObservation(changed.dockerAttempt), false);
    assert.throws(() => qualification(changed));
  }
  for (const flag of [
    "immutableInputsRechecked",
    "originalSourceRechecked",
    "runtimeToolsRechecked",
    "sdkToolsRechecked",
    "imageReinspected",
  ]) {
    const changed = syntheticReceipt();
    changed[flag] = false;
    assert.throws(() => qualification(changed));
  }
});
test("synthetic original inputs require restoration and exempt only exact enumerated producer targets", async (t) => {
  const directory = await temp(t);
  await mkdir(path.join(directory, "lib"));
  const reference = {
    originalSourceFiles: [
      { path: "lib/source.c", bytes: 6, sha256: hash("source") },
    ],
    preexistingProducerOutputs: [],
    producerOutputTargets: [],
  };
  await writeFile(path.join(directory, "lib/source.c"), "source");
  assert.equal(
    (await verifyOriginalSource(directory, reference)).originalInputsUnchanged,
    true,
  );
  await writeFile(path.join(directory, "lib/source.c"), "mutate");
  await assert.rejects(verifyOriginalSource(directory, reference));
  await writeFile(path.join(directory, "lib/source.c"), "source");
  assert.equal(
    (await verifyOriginalSource(directory, reference)).originalInputsUnchanged,
    true,
  );
  reference.preexistingProducerOutputs.push({
    sourcePath: "lib/source.c",
    expected: { bytes: 6, sha256: hash("output") },
  });
  await writeFile(path.join(directory, "lib/source.c"), "output");
  assert.equal(
    (await verifyOriginalSource(directory, reference)).files[0].kind,
    "source-derived-producer-output",
  );
  await writeFile(path.join(directory, "lib/source.c"), "mutate");
  await assert.rejects(verifyOriginalSource(directory, reference));
});
test("synthetic physical output bytes reject equal-size mutation missing files and require restoration", async (t) => {
  const directory = await temp(t),
    file = path.join(directory, "runtime.wasm");
  const expected = [{ path: "runtime.wasm", bytes: 6, sha256: hash("output") }];
  await writeFile(file, "output");
  assert.equal(
    (await compareOutputs(directory, "npm", expected)).matchesPublishedBytes,
    true,
  );
  await writeFile(file, "mutate");
  assert.equal(
    (await compareOutputs(directory, "npm", expected)).matchesPublishedBytes,
    false,
  );
  await writeFile(file, "output");
  assert.equal(
    (await compareOutputs(directory, "npm", expected)).matchesPublishedBytes,
    true,
  );
  await rm(file);
  await assert.rejects(compareOutputs(directory, "npm", expected));
});
test("preparation rejects JSON execution grants and policy overrides before reading source", async () => {
  const base = {
    schemaVersion: 1,
    task: "checktrail-runtime-controller-synthetic",
    recipe: "github",
    artifacts: [],
    runtime: null,
    offlineInputs: null,
  };
  for (const extension of [
    { operatorTrust: true },
    { run: true },
    { native: true },
    { limits: { cpus: 8 } },
    { executable: "anything" },
  ])
    await assert.rejects(prepare({ ...base, ...extension }));
});

test("pinned SDK banner requires its exact git version and physical source revision", async () => {
  const expected =
    "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 4.0.15-git (09f52557f0d48b65b8c724853ed8f4e8bf80e669)";
  const actual = expected + "\nCopyright (C) the Emscripten authors\n";
  const probes = runtimeVersionProbes({
    npmVersion: "11.19.1",
    rustVersion: "1.98.1",
  });
  assert.deepEqual(probes, [
    ["npm", ["--version"], "11.19.1"],
    ["rustc", ["--version"], "rustc 1.98.1 "],
    ["/work/sdk-node/bin/node", ["--version"], "v22.16.0"],
    ["/work/sdk/emscripten/emcc", ["--version"], expected],
  ]);
  assert.equal(versionProbeMatches(probes[3][0], actual, probes[3][2]), true);
  for (const invalid of [
    actual.replace("4.0.15-git", "4.0.150-git"),
    actual.replace("4.0.15-git", "4.0.15"),
    actual.replace(
      "09f52557f0d48b65b8c724853ed8f4e8bf80e669",
      "09f52557f0d48b65b8c724853ed8f4e8bf80e660",
    ),
  ])
    assert.equal(
      versionProbeMatches("/work/sdk/emscripten/emcc", invalid, expected),
      false,
    );
});

test("native host admission rejects ARM or emulated hosts and inconsistent runner metadata", () => {
  const valid = {
    platform: "linux",
    arch: "x64",
    machine: "x86_64",
    runnerOs: "Linux",
    runnerArch: "X64",
    hardwareAttestationPerformed: false,
  };
  validateNativeHost(valid);
  for (const [key, value] of [
    ["platform", "darwin"],
    ["arch", "arm64"],
    ["machine", "arm64"],
    ["runnerOs", "Windows"],
    ["runnerArch", "ARM64"],
    ["hardwareAttestationPerformed", true],
  ])
    assert.throws(() => validateNativeHost({ ...valid, [key]: value }));
  validateNativeHost({ ...valid, runnerOs: null, runnerArch: null });
});

test(
  "operator cancellation retains actual child termination and never qualifies a zero-exit interrupted observer",
  {
    skip:
      process.platform === "win32"
        ? "POSIX group cancellation belongs to the Linux-only native controller"
        : false,
  },
  async (t) => {
    const directory = await temp(t),
      cancellation = new globalThis.AbortController();
    const actual = await boundedProcess(
      process.execPath,
      ["--input-type=module", "-e", "setTimeout(()=>{},10000)"],
      {
        cwd: directory,
        env: {},
        prefix: path.join(directory, "cancelled"),
        deadline: performance.now() + 3000,
        signal: cancellation.signal,
        onSpawn: () => cancellation.abort(),
      },
    );
    assert.equal(actual.started, true);
    assert.equal(actual.terminalObserved, true);
    assert.equal(actual.interrupted, true);
    assert.equal(completeProcessObservation(actual), false);
    const falseSuccess = syntheticReceipt();
    falseSuccess.dockerAttempt.interrupted = true;
    assert.equal(falseSuccess.dockerAttempt.exitCode, 0);
    assert.throws(() => qualification(falseSuccess));
  },
);
