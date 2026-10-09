import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  prepared = JSON.parse(
    await readFile(
      path.join(repository, ".checktrail/hcl-context-runtime/identity.json"),
      "utf8",
    ),
  ),
  image = prepared.image;
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const [actual] = JSON.parse(
  execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
);
assert.equal(actual.Config.Labels["checktrail.task"], prepared.task);
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
  "--label",
  "checktrail.task=" + prepared.task,
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--workdir",
  "/workspace",
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--env",
  "CHECKTRAIL_CONTEXT_HCL_NATIVE=1",
  "--env",
  "CHECKPOINT_DISABLE=1",
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
    'import{execFileSync}from"node:child_process";import{readFileSync}from"node:fs";import{createHash}from"node:crypto";const files=["/usr/local/bin/terraform","/usr/local/bin/node","/usr/bin/git"];console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,terraform:JSON.parse(execFileSync("terraform",["version","-json"],{encoding:"utf8"})),git:execFileSync("git",["--version"],{encoding:"utf8"}).trim(),npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),os:readFileSync("/etc/os-release","utf8"),toolBytes:files.map(file=>{const bytes=readFileSync(file);return{file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};})}));',
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.terraform.terraform_version, "1.16.5");
assert.equal(
  runtime.toolBytes[0].sha256,
  "c9caf6b26aa487a470bd02d32ffe3e44fe5e95fa7e7f986cb9f2be61654f240c",
);
const source = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "cp -a /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs context-hcl",
  ]),
);
assert.equal(source.complete, true);
assert.equal(source.passed, 9);
// Mutations run on an owned compiled copy; captured source stays read-only.
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-hcl-context-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-hcl-context-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 31);
assert.ok(
  guards.controls.every(
    (c) =>
      c.originalPassed &&
      c.mutantCompiled &&
      c.mutantFailedAssertion &&
      c.restoredPassed,
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
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-hcl",
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
      temporaryFilesystemExecutable: false,
    },
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
