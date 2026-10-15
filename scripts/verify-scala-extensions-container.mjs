import assert from "node:assert/strict";
import process from "node:process";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected = process.env.CHECKTRAIL_SCALA_EXTENSIONS_IMAGE;
assert.ok(
  selected,
  "Select the operator-prepared pinned Scala extension image",
);
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task = process.env.CHECKTRAIL_TEST_TASK ?? "scala-extensions-acceptance";
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const cache = execFileSync("npm", ["config", "get", "cache"], {
  encoding: "utf8",
}).trim();
assert.ok(path.isAbsolute(cache));
const base = [
  "run",
  "--rm",
  "--init",
  "--network",
  "none",
  "--read-only",
  "--cpus",
  "2",
  "--memory",
  "2g",
  "--pids-limit",
  "256",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,exec,size=1024m",
  "--label",
  "checktrail.task=" + task,
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--workdir",
  "/workspace",
  image,
];
const invoke = promisify(execFile);
const run = async (args) =>
  (
    await invoke("docker", [...base, ...args], {
      encoding: "utf8",
      timeout: 1200000,
      maxBuffer: 4 * 1048576,
    })
  ).stdout;
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
const runtime = JSON.parse(
  await run([
    "node",
    "--input-type=module",
    "-e",
    'import{verifyJvmToolchain}from"./dist/src/jvm-extensions.js";import{jvmToolchainPins}from"./dist/src/jvm-toolchain-pins.js";import{scalaLibraries,scalaHash}from"./dist/src/scala-archive.js";import{scala2Libraries}from"./dist/src/scala2-archive.js";import{scalaArtifacts}from"./dist/src/scala-artifacts.js";import{scala2Artifacts}from"./dist/src/scala2-artifacts.js";import{scalaStagingLibrary}from"./dist/src/scala-extension-artifacts.js";import{readFile}from"node:fs/promises";import{execFileSync}from"node:child_process";const home=await verifyJvmToolchain();const a3=await readFile("/opt/checktrail/scala3-3.9.0.zip"),a2=await readFile("/opt/checktrail/scala-2.13.18.zip");const lib3=scalaLibraries(a3,true),lib2=scala2Libraries(a2);const node=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:scalaHash(node)},java:execFileSync("java",["--version"],{encoding:"utf8"}).trim(),javaHome:home,selectedNativeArtifacts:jvmToolchainPins.map(p=>({...p,byteVerified:true})),compilerArchives:[{version:scalaArtifacts.version,bytes:a3.length,sha256:scalaHash(a3)},{version:scala2Artifacts.version,bytes:a2.length,sha256:scalaHash(a2)}],selectedLibraries:[...scalaArtifacts.runtimeLibraries,scalaStagingLibrary].map(p=>({...p,byteVerified:scalaHash(lib3.get(p.name))===p.sha256})).concat(scala2Artifacts.runtimeLibraries.map(p=>({...p,byteVerified:scalaHash(lib2.get(p.name))===p.sha256}))),os:await readFile("/etc/os-release","utf8")}));',
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.equal(runtime.selectedNativeArtifacts.length, 4);
assert.equal(runtime.selectedLibraries.length, 14);
assert.ok(runtime.selectedLibraries.every((p) => p.byteVerified));
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);
const timings = {};
const measured = async (name, action) => {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timings[name] = Math.round(performance.now() - started);
    process.stderr.write(
      JSON.stringify({ stageCompleted: name, durationMs: timings[name] }) +
        "\n",
    );
  }
};
// Separate read-only containers own their /tmp and caches. Heavy named callbacks
// remain serial within each container; aggregate admission is two containers.
const groups = await Promise.allSettled([
  measured("baseline-regressions-installed-warning", async () => {
    stage("preserved-native");
    const baseline = JSON.parse(
      await run([
        "node",
        "scripts/verify-required-native-tests.mjs",
        "scala",
        "java",
      ]),
    );
    assert.equal(
      baseline.required,
      requirements.scala.length + requirements.java.length,
    );
    assert.equal(baseline.complete, true);
    stage("native-regressions");
    const regressions = await run([
      "node",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      "dist/test/scala-extension-regressions.test.js",
      "dist/test/scala-java-warning-policy.test.js",
    ]);
    assert.match(regressions, /# tests 4\n/);
    assert.match(regressions, /# pass 4\n/);
    assert.match(regressions, /# fail 0\n/);
    assert.match(regressions, /# skipped 0\n/);
    stage("fresh-installed-java-warning-policy");
    const installedJavaWarningPolicy = JSON.parse(
      await run([
        "/bin/sh",
        "-c",
        "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache > /tmp/cache.json && node scripts/verify-jvm-java-warning-package.mjs scala",
      ]),
    );
    assert.equal(installedJavaWarningPolicy.acceptance.complete, true);
    assert.equal(installedJavaWarningPolicy.acceptance.passed, 1);

    return { baseline, regressions, installedJavaWarningPolicy };
  }),
  measured("source-installed-compiling-controls", async () => {
    stage("source-and-fresh-installation");
    const lines = (
      await run([
        "/bin/sh",
        "-c",
        "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_SCALA_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs scala-extensions && cat /tmp/installed-receipt.json",
      ])
    )
      .trim()
      .split("\n");
    assert.equal(lines.length, 3);
    const preparedCache = JSON.parse(lines[0]),
      source = JSON.parse(lines[1]),
      installed = JSON.parse(lines[2]);
    assert.equal(source.required, 9);
    assert.equal(source.passed, 9);
    assert.equal(source.complete, true);
    assert.equal(installed.profile.required, 9);
    assert.equal(installed.profile.passed, 9);
    assert.equal(installed.profile.complete, true);
    stage("compiling-controls");
    const guards = JSON.parse(
      await run([
        "/bin/sh",
        "-c",
        "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-scala-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-scala-extensions-guards.mjs",
      ]),
    );
    assert.equal(guards.controls.length, 13);
    assert.equal(guards.allComplete, true);
    assert.ok(
      guards.controls.every(
        (c) =>
          c.originalPassed &&
          c.mutantCompiled &&
          c.mutantFailedAssertion &&
          c.restoredPassed,
      ),
    );

    return { preparedCache, source, installed, guards };
  }),
]);
const failures = groups.filter((group) => group.status === "rejected");
if (failures.length)
  throw new AggregateError(
    failures.map((group) => group.reason),
    "Required Scala native stages failed",
  );
const { baseline, regressions, installedJavaWarningPolicy } = groups[0].value;
const { preparedCache, source, installed, guards } = groups[1].value;
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    stageDurationMs: timings,
    maxConcurrentContainers: 2,
    aggregateLimits: {
      cpus: 4,
      memoryMiB: 4096,
      pids: 512,
      temporaryFilesystemMiB: 2048,
    },
    runtime,
    environment: {
      image,
      network: "none",
      rootFilesystemReadonly: true,
      sourceMountReadonly: true,
      preparedCacheReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 1024,
      temporaryFilesystemExecutable: true,
    },
    preparedCache,
    baseline,
    source,
    installed,
    guards,
    regressions: {
      tests: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
      outputSha256: (await import("node:crypto"))
        .createHash("sha256")
        .update(regressions)
        .digest("hex"),
    },
    installedJavaWarningPolicy,
    complete: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
