import {
  jvmPhaseDigest,
  jvmWrapperCiContext,
  jvmWrapperCompiledHarnessIdentity,
  jvmWrapperPhaseSummary,
  jvmWrapperSourceIdentity,
  publishJvmWrapperPhaseOutput,
  requireJvmWrapperPhaseSummaries,
  selectJvmWrapperPhases,
} from "./jvm-wrapper-phase-evidence.mjs";
import { attemptOutputCodeIdentity } from "./attempt-output-evidence.mjs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const phases = selectJvmWrapperPhases(process.argv.slice(2));
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected = process.env.CHECKTRAIL_JVM_WRAPPERS_IMAGE;
assert.ok(selected, "Select the operator-prepared pinned JVM wrapper image");
const sourceBefore = await jvmWrapperSourceIdentity(repository);
const compiledCode = await attemptOutputCodeIdentity(repository);
const compiledHarness = await jvmWrapperCompiledHarnessIdentity(repository);
const ci = jvmWrapperCiContext(process.env);

const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task = process.env.CHECKTRAIL_TEST_TASK ?? "jvm-wrappers-acceptance";
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
  "--env",
  "CHECKTRAIL_MAVEN_CACHE=/workspace/.checktrail",
  "--env",
  "CHECKTRAIL_GRADLE_CACHE=/workspace/.checktrail",
  "--env",
  "CHECKTRAIL_JVM_WRAPPERS_CACHE=/workspace/.checktrail",
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
    'import{verifyJvmToolchain,verifyJvmFile}from "./dist/src/jvm-extensions.js";import{jvmToolchainPins}from "./dist/src/jvm-toolchain-pins.js";import{jvmWrapperPins,jvmWrapperArchives}from "./dist/src/jvm-wrapper-pins.js";import{readFile}from "node:fs/promises";import{createHash}from "node:crypto";import{execFileSync}from "node:child_process";const prefix=await verifyJvmToolchain();for(const pin of jvmWrapperPins)await verifyJvmFile(".checktrail/jvm-wrapper-tools/wrapper-artifacts/"+pin.path,pin);for(const pin of Object.values(jvmWrapperArchives))await verifyJvmFile(".checktrail/jvm-wrapper-tools/"+pin.file,pin);const bytes=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")},java:execFileSync("java",["--version"],{encoding:"utf8"}).trim(),selectedNativeArtifacts:jvmToolchainPins.map(p=>({...p,byteVerified:true})),wrapperArtifacts:jvmWrapperPins.map(p=>({...p,byteVerified:true})),archiveArtifacts:Object.values(jvmWrapperArchives).map(p=>({...p,byteVerified:true})),os:await readFile("/etc/os-release","utf8")}));',
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.match(runtime.java, /Temurin-25\.0\.4\+7/);
assert.equal(runtime.selectedNativeArtifacts.length, 4);
assert.equal(runtime.wrapperArtifacts.length, 8);
assert.equal(runtime.archiveArtifacts.length, 2);
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);

function baselinePhase() {
  stage("native-preparation-ownership");
  const preparationOwnership = JSON.parse(
    run(["node", "scripts/verify-jvm-preparation-ownership.mjs"]),
  );
  assert.equal(preparationOwnership.positiveComplete, true);
  assert.equal(preparationOwnership.rootOwnedNegativeReproduced, true);
  stage("preserved-baseline");
  const baselineProfiles = ["java", "maven", "gradle"],
    baseline = JSON.parse(
      run([
        "node",
        "scripts/verify-required-native-tests.mjs",
        ...baselineProfiles,
      ]),
    );
  assert.equal(
    baseline.required,
    baselineProfiles.reduce((n, p) => n + requirements[p].length, 0),
  );
  assert.equal(baseline.complete, true);
  return { preparationOwnership, baseline };
}

function acceptancePhase() {
  stage("source-and-nested-installation");
  const sourceLines = run([
    "/bin/sh",
    "-c",
    'node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_JVM_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs jvm-wrappers && node -e \'process.stdout.write(require("node:fs").readFileSync("/tmp/installed-receipt.json")+"\\n")\'',
  ])
    .trim()
    .split("\n");
  assert.equal(sourceLines.length, 3);
  const preparedCache = JSON.parse(sourceLines[0]),
    source = JSON.parse(sourceLines[1]),
    installed = JSON.parse(sourceLines[2]);
  assert.equal(source.required, 9);
  assert.equal(source.passed, 9);
  assert.equal(source.complete, true);
  assert.equal(installed.profile.required, 9);
  assert.equal(installed.profile.passed, 9);
  assert.equal(installed.profile.complete, true);
  assert.equal(installed.offlineProductionInstall, true);
  assert.equal(installed.harnessOutsideInstalledPackage, true);
  return { preparedCache, source, installed };
}

function guardsRegressionPhase() {
  stage("compiling-guards");
  const guardLines = run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-jvm-wrappers-guards.mjs scripts/capture-jvm-wrapper-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/capture-jvm-wrapper-guards.mjs /tmp/native-receipts && CHECKTRAIL_JVM_GUARD_RECEIPTS=/tmp/native-receipts node scripts/verify-jvm-wrappers-guards.mjs",
  ])
    .trim()
    .split("\n");
  assert.equal(guardLines.length, 2);
  const guardCapture = JSON.parse(guardLines[0]),
    guards = JSON.parse(guardLines[1]);
  assert.equal(guardCapture.nativeReceipts, 2);
  assert.equal(guards.controls.length, 21);
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
    "--test-reporter=tap",
    "--test-concurrency=1",
    "dist/test/jvm-wrappers.test.js",
    "dist/test/schemas.test.js",
  ]);
  assert.match(regressions, /# fail 0\n/);
  assert.match(regressions, /# skipped 0\n/);
  const pass = regressions.match(/# pass (\d+)\n/);
  assert.ok(pass && Number(pass[1]) > 0);
  return {
    guardCapture,
    guards,
    regressions: {
      passed: Number(pass[1]),
      failed: 0,
      skipped: 0,
      diagnosticSha256: createHash("sha256").update(regressions).digest("hex"),
    },
  };
}

const environment = {
  network: "none",
  sourceMount: "readonly",
  rootFilesystemReadonly: true,
  cpus: 2,
  memoryMiB: 4096,
  pids: 256,
  temporaryFilesystemMiB: 2048,
  temporaryFilesystemExecutable: true,
};
const limitations = {
  wholeJdkAndSystemClosureVerified: false,
  publisherAndLicenseClosureVerified: false,
  finalMatrixAccepted: false,
  gateAComplete: false,
  inferenceInvoked: false,
  fieldEvaluationExecuted: false,
};
const bindings = {
  source: sourceBefore.sha256,
  compiledCode,
  compiledHarness,
  runtime: jvmPhaseDigest(JSON.stringify(runtime)),
};
const runPhase = {
  baseline: baselinePhase,
  acceptance: acceptancePhase,
  "guards-regressions": guardsRegressionPhase,
};
const receipts = [];
const summaries = [];
for (const phase of phases) {
  const started = performance.now();
  const result = runPhase[phase]();
  assert.deepEqual(await jvmWrapperSourceIdentity(repository), sourceBefore);
  assert.equal(await attemptOutputCodeIdentity(repository), compiledCode);
  assert.equal(
    await jvmWrapperCompiledHarnessIdentity(repository),
    compiledHarness,
  );
  const receipt = {
    schemaVersion: 1,
    scope: "jvm-wrapper-native-phase",
    phase,
    phaseComplete: true,
    allPhasesComplete: false,
    bindings,
    ci,
    image,
    runtime,
    ...result,
    durationMs: Math.round(performance.now() - started),
    environment,
    ...limitations,
  };
  const summary = jvmWrapperPhaseSummary(receipt);
  receipts.push(receipt);
  summaries.push(summary);
}
let report;
if (phases.length === 3) {
  const combined = requireJvmWrapperPhaseSummaries(summaries, {
    source: sourceBefore.sha256,
    ci,
  });
  // Preserve the original default all-phases result fields for local operators.
  report = {
    ...receipts[0],
    ...receipts[1],
    ...receipts[2],
    scope: "jvm-wrapper-native-all-phases",
    phase: "all",
    phaseDurationsMs: Object.fromEntries(
      receipts.map(({ phase, durationMs }) => [phase, durationMs]),
    ),
    allPhasesComplete: combined.complete,
    callbacks: requirements["jvm-wrappers"],
    phaseSummaries: summaries,
  };
  delete report.durationMs;
} else report = { ...receipts[0], summary: summaries[0] };
if (ci && process.env.GITHUB_OUTPUT)
  for (const summary of summaries)
    await publishJvmWrapperPhaseOutput(summary, process.env.GITHUB_OUTPUT);
process.stdout.write(JSON.stringify(report) + "\n");
