import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  selected =
    process.env.CHECKTRAIL_FSHARP_FORMAT_IMAGE ??
    "checktrail-fsharp-format:10.0.401",
  task = process.env.CHECKTRAIL_TEST_TASK;
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const cache = execFileSync("npm", ["config", "get", "cache"], {
    encoding: "utf8",
  }).trim(),
  dependencies = await (
    await import("node:fs/promises")
  ).realpath(
    process.env.CHECKTRAIL_DOTNET_BUILD_CACHE ??
      path.join(repository, ".checktrail/dotnet-build-dependencies"),
  );
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
  ...(task ? ["--label", "checktrail.task=" + task] : []),
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--mount",
  `type=bind,src=${dependencies},target=/dependencies,readonly`,
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--env",
  "CHECKTRAIL_DOTNET_BUILD_CACHE=/dependencies",
  "--env",
  "CHECKTRAIL_FSHARP_FORMAT_CACHE=/workspace/.checktrail/fsharp-format-tools",
  "--workdir",
  "/workspace",
  image,
];
const run = (args) => {
  try {
    return execFileSync("docker", [...base, ...args], {
      encoding: "utf8",
      timeout: 1200000,
      maxBuffer: 16 * 1048576,
    });
  } catch (error) {
    throw Error(
      "F# acceptance stage failed: " +
        String(error.stderr ?? error.message).slice(-3000),
      { cause: error },
    );
  }
};
const stage = (name) =>
    process.stderr.write(JSON.stringify({ stage: name }) + "\n"),
  started = performance.now();
stage("selected-runtime-and-formatter-components");
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `
import assert from 'node:assert/strict';import {realpath,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {verifyFsharpSdk,verifyFsharpFormatter} from './dist/src/fsharp-format.js';import {fsharpSdkPins,fsharpFormatterPins,fantomasPackagePin} from './dist/src/fsharp-format-pins.js';
const tool=await realpath('/usr/bin/dotnet').catch(()=>realpath('/usr/share/dotnet/dotnet')),sdkRoot=tool.slice(0,tool.lastIndexOf('/'));assert.equal(await verifyFsharpSdk(sdkRoot),tool);await verifyFsharpFormatter('/workspace','.','.checktrail/fsharp-format-tools');assert.equal(process.getuid(),1000);const bytes=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},sdk:{version:'10.0.401',runtime:'10.0.12',selectedComponents:fsharpSdkPins.length,selectedBytes:fsharpSdkPins.reduce((n,p)=>n+p.bytes,0),pinsSha256:createHash('sha256').update(JSON.stringify(fsharpSdkPins)).digest('hex'),byteVerified:true,wholeClosureVerified:false},formatter:{package:fantomasPackagePin,selected:fsharpFormatterPins,readableBySelectedUser:true,selectedUserId:process.getuid()},os:await readFile('/etc/os-release','utf8')}));
`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
const npmVersion = run(["npm", "--version"]).trim();
assert.match(npmVersion, /^\d+\.\d+\.\d+$/);
runtime.npm = { version: npmVersion };
stage("preserved-dotnet-build-and-csharp-vb-formatting");
const requirements = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  ),
  baselineProfiles = ["dotnet-build", "dotnet-format"],
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
assert.equal(baseline.ledger.cases.length, baseline.required);
assert.ok(
  baseline.ledger.cases.every(
    (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
  ),
);
stage("source-and-fresh-offline-production-installation");
const lines = run([
  "sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_FSHARP_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs dotnet-fsharp-format && cat /tmp/installed-receipt.json",
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
assert.equal(installed.offlineProductionInstall, true);
assert.equal(installed.harnessOutsideInstalledPackage, true);
stage("compiling-guards-and-native-observer-mutations");
const guards = JSON.parse(
  run([
    "sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-fsharp-format-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && cd /tmp/guards && node scripts/verify-fsharp-format-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 19);
assert.equal(guards.allComplete, true);
assert.equal(guards.sourceRestored, true);
assert.equal(guards.callbacksUnchanged, true);
assert.equal(
  guards.controls.filter((c) => c.mutatedNativeObserverCompiled).length,
  2,
);
console.log(
  JSON.stringify({
    schemaVersion: 1,
    profile: "dotnet-fsharp-format",
    runtime,
    environment: {
      network: "none",
      readOnlyRoot: true,
      user: "1000:1000",
      cpuLimit: 2,
      memoryBytes: 4 * 1024 * 1024 * 1024,
      pidLimit: 256,
      tmpfsBytes: 2 * 1024 * 1024 * 1024,
    },
    baselineProfiles,
    baseline,
    preparedCache,
    source,
    installed,
    guards,
    durationMs: Math.round(performance.now() - started),
    complete: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    wholeRuntimeClosureVerified: false,
    platformMatrixComplete: false,
    gateAComplete: false,
  }),
);
