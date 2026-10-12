import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  selected = process.env.CHECKTRAIL_JVM_ANALYZER_EXTENSIONS_IMAGE;
assert.ok(selected, "Select the operator-prepared pinned JVM analyzer image");
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? "jvm-analyzer-extensions-acceptance";
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
  "--user",
  "1000:1000",
  "--cpus",
  "2",
  "--memory",
  "4g",
  "--pids-limit",
  "256",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,exec,size=2048m",
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
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    timeout: 1200000,
    maxBuffer: 8 * 1048576,
  });
const stage = (name) =>
    process.stderr.write(JSON.stringify({ stage: name }) + "\n"),
  started = performance.now();
stage("runtime-and-selected-artifact-bytes");
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import{verifyJvmToolchain}from"./dist/src/jvm-extensions.js";import{jvmToolchainPins}from"./dist/src/jvm-toolchain-pins.js";import{detektArtifacts}from"./dist/src/detekt-artifacts.js";import{kotlinArtifacts}from"./dist/src/kotlin-artifacts.js";import{spotbugsArtifacts}from"./dist/src/spotbugs-artifacts.js";import{readFile}from"node:fs/promises";import{createHash}from"node:crypto";import{execFileSync}from"node:child_process";const hash=(b)=>createHash("sha256").update(b).digest("hex"),home=await verifyJvmToolchain(),artifacts=[];for(const[file,bytes,sha256]of[["detekt-cli-2.0.0-alpha.6-all.jar",detektArtifacts.jarBytes,detektArtifacts.jarSha256],["spotbugs-4.10.4.tgz",15831983,spotbugsArtifacts.archiveSha256],["kotlin-compiler-2.4.10.zip",kotlinArtifacts.archiveBytes,kotlinArtifacts.archiveSha256]]){const actual=await readFile("/opt/checktrail/"+file);if(actual.length!==bytes||hash(actual)!==sha256)throw Error("Selected artifact differs");artifacts.push({file,bytes,sha256,byteVerified:true});}const node=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:hash(node)},java:execFileSync("java",["--version"],{encoding:"utf8"}).trim(),javaHome:home,selectedNativeArtifacts:jvmToolchainPins.map(p=>({...p,byteVerified:true})),artifacts,os:await readFile("/etc/os-release","utf8")}));`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.equal(runtime.selectedNativeArtifacts.length, 4);
assert.equal(runtime.artifacts.length, 3);
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);
stage("preserved-java-spotbugs-detekt");
const baseline = JSON.parse(
  run([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "java",
    "spotbugs",
    "detekt",
  ]),
);
assert.equal(
  baseline.required,
  requirements.java.length +
    requirements.spotbugs.length +
    requirements.detekt.length,
);
assert.equal(baseline.complete, true);
stage("source-and-fresh-offline-installation");
const lines = run([
  "sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_JVM_ANALYZER_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs jvm-analyzer-extensions && cat /tmp/installed-receipt.json",
])
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
stage("original-native-regressions");
const regressionFiles = [
  "spotbugs-extensions.test.js",
  "spotbugs-extensions-inputs.test.js",
  "spotbugs-plugin-jar.test.js",
  "detekt-extensions.test.js",
];
const regressions = run([
  "node",
  "--test",
  "--test-concurrency=1",
  ...regressionFiles.map((f) => "dist/test/" + f),
]);
assert.match(regressions, /^# tests 12$/m);
assert.match(regressions, /^# pass 12$/m);
assert.match(regressions, /^# fail 0$/m);
assert.match(regressions, /^# skipped 0$/m);
stage("compiling-guard-controls");
const guards = JSON.parse(
  run([
    "sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-jvm-analyzer-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-jvm-analyzer-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 19);
assert.equal(guards.allComplete, true);
assert.equal(guards.callbacksUnchanged, true);
assert.equal(guards.sourceRestored, true);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    runtime,
    environment: {
      image,
      network: "none",
      init: true,
      rootFilesystemReadonly: true,
      sourceMountReadonly: true,
      preparedCacheReadonly: true,
      user: "1000:1000",
      cpus: 2,
      memoryMiB: 4096,
      pids: 256,
      temporaryFilesystemMiB: 2048,
      temporaryFilesystemExecutable: true,
    },
    preparedCache,
    baseline,
    source,
    installed,
    guards,
    regressions: {
      files: regressionFiles,
      tests: 12,
      passed: 12,
      failed: 0,
      skipped: 0,
      outputSha256: createHash("sha256").update(regressions).digest("hex"),
    },
    durationMs: Math.round(performance.now() - started),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    gateAComplete: false,
    qualityAssessed: false,
  }) + "\n",
);
