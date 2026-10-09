import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected =
  process.env.CHECKTRAIL_CPP_CONTEXT_IMAGE ??
  "checktrail-cpp-context:synthetic-v1";
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
  "/tmp:rw,nosuid,nodev,exec,size=512m",
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
    'import {execFileSync}from"node:child_process";import{readFileSync}from"node:fs";import{createHash}from"node:crypto";const compiler=execFileSync("g++",["-dumpfullversion"],{encoding:"utf8"}).trim();const files=["/usr/bin/g++","/usr/bin/as","/usr/bin/ld",execFileSync("g++",["-print-prog-name=cc1plus"],{encoding:"utf8"}).trim(),"/usr/local/bin/node","/usr/bin/git"];console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,compiler,compilerTarget:execFileSync("g++",["-dumpmachine"],{encoding:"utf8"}).trim(),compilerIdentity:execFileSync("g++",["--version"],{encoding:"utf8"}).trim(),git:execFileSync("git",["--version"],{encoding:"utf8"}).trim(),npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),os:readFileSync("/etc/os-release","utf8"),toolBytes:files.map(file=>{const bytes=readFileSync(file);return {file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};})}));',
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.compiler, "14.2.0");
assert.equal(runtime.compilerTarget, "aarch64-linux-gnu");
assert.match(runtime.compilerIdentity, /Debian 14\.2\.0-19/);
const source = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "cp -a /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs context-cpp",
  ]),
);
assert.equal(source.complete, true);
assert.equal(source.passed, 9);
// Guard mutations operate only on an owned compiled copy; the source mount stays read-only.
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-cpp-context-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-cpp-context-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 40);
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
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-cpp",
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
      "Original synthetic C++ selected-binding controls; no AI inference or field evaluation",
    runtime,
    image,
    source,
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
      temporaryFilesystemExecutable: true,
    },
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
