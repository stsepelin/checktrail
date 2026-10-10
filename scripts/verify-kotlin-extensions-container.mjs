import assert from "node:assert/strict";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected = process.env.CHECKTRAIL_KOTLIN_EXTENSIONS_IMAGE;
assert.ok(
  selected,
  "Select the operator-prepared pinned Kotlin extension image",
);
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task = process.env.CHECKTRAIL_TEST_TASK ?? "kotlin-extensions-acceptance";
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
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    timeout: 1200000,
    maxBuffer: 4 * 1048576,
  });
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    'import{verifyJvmToolchain}from"./dist/src/jvm-extensions.js";import{jvmToolchainPins}from"./dist/src/jvm-toolchain-pins.js";import{kotlinLibraries,kotlinHash}from"./dist/src/kotlin-archive.js";import{kotlinArtifacts}from"./dist/src/kotlin-artifacts.js";import{kotlinScriptingArtifacts}from"./dist/src/kotlin-extension-artifacts.js";import{readFile}from"node:fs/promises";import{execFileSync}from"node:child_process";const home=await verifyJvmToolchain();const compiler=await readFile("/opt/checktrail/kotlin-compiler-2.4.10.zip");const libraries=kotlinLibraries(compiler,true);const node=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:kotlinHash(node)},java:execFileSync("java",["--version"],{encoding:"utf8"}).trim(),javaHome:home,selectedNativeArtifacts:jvmToolchainPins.map(p=>({...p,byteVerified:true})),compilerArchive:{bytes:compiler.length,sha256:kotlinHash(compiler)},selectedLibraries:[...kotlinArtifacts.runtimeLibraries,...kotlinScriptingArtifacts].map(p=>({...p,byteVerified:kotlinHash(libraries.get(p.name))===p.sha256})),os:await readFile("/etc/os-release","utf8")}));',
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.equal(runtime.selectedNativeArtifacts.length, 4);
assert.equal(runtime.selectedLibraries.length, 10);
assert.ok(runtime.selectedLibraries.every((p) => p.byteVerified));
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);
stage("preserved-native");
const baseline = JSON.parse(
  run(["node", "scripts/verify-required-native-tests.mjs", "kotlin", "java"]),
);
assert.equal(
  baseline.required,
  requirements.kotlin.length + requirements.java.length,
);
assert.equal(baseline.complete, true);
stage("source-and-fresh-installation");
const lines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_KOTLIN_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs kotlin-extensions && cat /tmp/installed-receipt.json",
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
stage("compiling-controls");
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-kotlin-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-kotlin-extensions-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 12);
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
stage("native-regressions");
const regressions = run([
  "node",
  "--test",
  "--test-concurrency=1",
  "--test-reporter=tap",
  "dist/test/kotlin-extension-regressions.test.js",
  "dist/test/kotlin-java-warning-policy.test.js",
]);
assert.match(regressions, /# tests 7\n/);
assert.match(regressions, /# pass 7\n/);
assert.match(regressions, /# fail 0\n/);
assert.match(regressions, /# skipped 0\n/);
stage("fresh-installed-java-warning-policy");
const installedJavaWarningPolicy = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache > /tmp/cache.json && node scripts/verify-jvm-java-warning-package.mjs kotlin",
  ]),
);
assert.equal(installedJavaWarningPolicy.acceptance.complete, true);
assert.equal(installedJavaWarningPolicy.acceptance.passed, 1);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
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
      tests: 7,
      passed: 7,
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
