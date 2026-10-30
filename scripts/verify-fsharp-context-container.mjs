import { readFile } from "node:fs/promises";
import { captureConsumerWitnessController } from "./consumer-witness-controller.mjs";
import {
  bindConsumerWitnessController,
  inspectConsumerWitnesses,
  requireQualifiedConsumerWitnessFamily,
} from "./consumer-witness-evidence.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected =
  process.env.CHECKTRAIL_FSHARP_CONTEXT_IMAGE ??
  "checktrail-fsharp-context:synthetic-v1";
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
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
  "/tmp:rw,nosuid,nodev,noexec,size=512m",
  ...(process.env.CHECKTRAIL_TEST_TASK
    ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
    : []),
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--workdir",
  "/workspace",
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  image,
];
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1048576,
    timeout: 240000,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    'import {execFileSync} from "node:child_process";import {readFileSync,readdirSync} from "node:fs";import {createHash} from "node:crypto";import {observeConsumerWitnessTool,observeConsumerWitnessManagedInputs} from "./dist/test/consumer-witness-fixture.js";const ref="/usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0";console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,compiler:execFileSync("dotnet",["/usr/share/dotnet/sdk/10.0.401/FSharp/fsc.dll","--version"],{encoding:"utf8"}).trim(),dotnet:execFileSync("dotnet",["--version"],{encoding:"utf8"}).trim(),runtimes:execFileSync("dotnet",["--list-runtimes"],{encoding:"utf8"}).trim(),fsharpCore:{bytes:readFileSync("/usr/share/dotnet/sdk/10.0.401/FSharp/FSharp.Core.dll").length,sha256:createHash("sha256").update(readFileSync("/usr/share/dotnet/sdk/10.0.401/FSharp/FSharp.Core.dll")).digest("hex")},referenceLibraries:readdirSync(ref).filter(name=>name.endsWith(".dll")).sort().map(name=>({name,bytes:readFileSync(ref+"/"+name).length,sha256:createHash("sha256").update(readFileSync(ref+"/"+name)).digest("hex")})),git:execFileSync("git",["--version"],{encoding:"utf8"}).trim(),npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),os:readFileSync("/etc/os-release","utf8"),nodeExecutableSha256:createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),distributionSha256:createHash("sha256").update(readFileSync("/etc/os-release")).digest("hex"),tool:await observeConsumerWitnessTool("fsharp"),managedInputs:await observeConsumerWitnessManagedInputs("fsharp")}));',
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.dotnet, "10.0.401");
assert.equal(
  runtime.compiler,
  "Microsoft (R) F# Compiler version 15.2.401.0 for F# 10.0",
);
assert.match(runtime.runtimes, /Microsoft.NETCore.App 10\.0\.12/);
assert.ok(runtime.referenceLibraries.length > 100);
assert.deepEqual(runtime.fsharpCore, {
  bytes: 4706600,
  sha256: "d07ca9f9df6f47c9a03d64e4c46897169788209033d9144c7a237440b2567c09",
});
const consumerRuntime = {
  ...runtime,
  node: runtime.node.slice(1),
  architecture: runtime.arch,
  hostAttestationPerformed: false,
  toolVersion: runtime.compiler,
};
const consumerExpected = await captureConsumerWitnessController(
  repository,
  "fsharp",
  { kind: "oci-image-observation", id: image },
  consumerRuntime,
  runtime.tool,
);
const consumerCollection = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "cp -a /prepared-cache /tmp/npm-cache && node scripts/verify-consumer-witness-profile.mjs context-fsharp",
  ]),
);
const source = consumerCollection.evidence;
consumerCollection.bindings = bindConsumerWitnessController(
  consumerCollection,
  consumerExpected,
);
consumerCollection.coverage = inspectConsumerWitnesses(
  JSON.parse(
    await readFile(
      path.join(repository, "docs/gate-a-consumer-witnesses.v1.json"),
      "utf8",
    ),
  ),
  JSON.parse(
    await readFile(
      path.join(repository, "docs/gate-a-profiles.v1.json"),
      "utf8",
    ),
  ),
  JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  ),
  consumerCollection.observations,
  consumerCollection.bindings,
  consumerCollection.attemptRecords,
);
requireQualifiedConsumerWitnessFamily(consumerCollection.coverage, "fsharp");
assert.equal(source.complete, true);
assert.equal(source.passed, 9);
// Guard mutations operate only on an owned compiled copy; the source mount stays read-only.
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-fsharp-context-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-fsharp-context-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 29);
assert.ok(
  guards.controls.every(
    (control) =>
      control.originalPassed &&
      control.mutantCompiled &&
      control.mutantFailedAssertion &&
      control.restoredPassed,
  ),
);
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-fsharp",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
      timeout: 120000,
    },
  ),
);
assert.equal(installed.profile.complete, true);
assert.equal(installed.profile.passed, 9);
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic F# selected-binding controls; no AI inference or field evaluation",
    runtime,
    image,
    source,
    consumerWitnesses: consumerCollection,
    guards,
    installed,
    environment: {
      network: "none",
      sourceMount: "readonly",
      rootFilesystemReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 512,
      temporaryFilesystemExecutable: false,
    },
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
