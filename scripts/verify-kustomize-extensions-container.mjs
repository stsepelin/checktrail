import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = await (
  await import("node:fs/promises")
).realpath(fileURLToPath(new URL("../", import.meta.url)));
const prepared = JSON.parse(
  await readFile(
    path.join(repository, ".checktrail/infra-tools-runtime/identity.json"),
    "utf8",
  ),
);
const image = prepared.image,
  task = prepared.task;
assert.equal(prepared.buildNetwork, "none");
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
assert.equal(prepared.tag, `checktrail-${task}:public`);
const [selected] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.tag], {
    encoding: "utf8",
  }),
);
assert.equal(selected.Id, image);
assert.equal(selected.Config.Labels["checktrail.task"], task);
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
  "--env",
  "CHECKTRAIL_INFRA_TOOLS_NATIVE=1",
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
    `
import {kubeSchemaPins,kubeBinarySha256} from "./dist/src/kubeconform.js";
import {kustomizeBinarySha256} from "./dist/src/kustomize.js";
import {readFile,readdir,lstat,realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import assert from "node:assert/strict";
const hash=b=>createHash("sha256").update(b).digest("hex"),pins=kubeSchemaPins,directory="/opt/checktrail-schemas";
assert.deepEqual((await readdir(directory)).sort(),pins.map(p=>p.file).sort());
for(const p of pins){const file=directory+"/"+p.file,info=await lstat(file);assert.ok(info.isFile()&&!info.isSymbolicLink());assert.equal(await realpath(file),file);const bytes=await readFile(file);assert.equal(bytes.length,p.bytes);assert.equal(hash(bytes),p.sha256);}
const tool=await realpath("/usr/local/bin/kubeconform"),binary=await readFile(tool),renderer=await realpath("/usr/local/bin/kustomize"),renderBinary=await readFile(renderer),node=await readFile(process.execPath);
assert.equal(hash(binary),kubeBinarySha256);assert.equal(hash(renderBinary),kustomizeBinarySha256);
console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:hash(node)},kubeconform:{version:execFileSync(tool,["-v"],{encoding:"utf8"}).trim(),bytes:binary.length,sha256:hash(binary),byteVerified:true},kustomize:{version:execFileSync(renderer,["version"],{encoding:"utf8"}).trim(),bytes:renderBinary.length,sha256:hash(renderBinary),byteVerified:true},schemas:pins.map(({file,bytes,sha256})=>({file,bytes,sha256,byteVerified:true})),os:await readFile("/etc/os-release","utf8")}));
`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.equal(runtime.kubeconform.version, "v0.8.0");
assert.equal(runtime.schemas.length, 3);
assert.equal(runtime.kustomize.version, "v5.8.2");
assert.deepEqual(
  runtime.schemas.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
  prepared.artifacts
    .filter((p) => p.path.startsWith("schemas/"))
    .map((p) => ({ file: p.path.slice(8), bytes: p.bytes, sha256: p.sha256 })),
);
const requirements = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);
stage("preserved-kubeconform-and-kustomize");
const baseline = JSON.parse(
  run([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "kubeconform",
    "kustomize",
  ]),
);
assert.equal(
  baseline.required,
  requirements.kubeconform.length + requirements.kustomize.length,
);
assert.equal(baseline.complete, true);
stage("source-and-fresh-offline-installation");
const lines = run([
  "sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_KUSTOMIZE_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs kustomize-extensions && cat /tmp/installed-receipt.json",
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
const regressionFiles = ["kustomize-extensions.test.js"];
const regressions = run([
  "node",
  "--test",
  "--test-concurrency=1",
  ...regressionFiles.map((f) => "dist/test/" + f),
]);
assert.match(regressions, /^# tests 7$/m);
assert.match(regressions, /^# pass 7$/m);
assert.match(regressions, /^# fail 0$/m);
assert.match(regressions, /^# skipped 0$/m);
stage("compiling-guard-controls");
const guards = JSON.parse(
  run([
    "sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-kustomize-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && cd /tmp/guards && node scripts/verify-kustomize-extensions-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 28);
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
      tests: 7,
      passed: 7,
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
