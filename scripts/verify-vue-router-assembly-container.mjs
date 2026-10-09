import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image =
  "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `router-assembly-${process.pid}`;
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
  "/tmp:rw,nosuid,nodev,noexec,size=512m",
  "--label",
  "checktrail.task=" + task,
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
    timeout: 300000,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    'import {readFileSync} from "node:fs";import {createHash}from"node:crypto";import {vueRouterAssemblyRuntimePins,vueRouterAssemblyRuntimeMatches} from "./dist/src/vue-router-runtime-pins.js";const base=".checktrail/vue-router-tools/node_modules/",router=JSON.parse(readFileSync(base+"vue-router/package.json","utf8")),vue=JSON.parse(readFileSync(base+"vue/package.json","utf8")),node=readFileSync("/usr/local/bin/node");console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,router:router.version,vue:vue.version,os:readFileSync("/etc/os-release","utf8"),nodeBinary:{bytes:node.length,sha256:createHash("sha256").update(node).digest("hex")},selectedRouterBundles:vueRouterAssemblyRuntimePins,selectedRouterBytesMatch:await vueRouterAssemblyRuntimeMatches(process.cwd()+"/"+base+"vue-router/vue-router.node.mjs")}));',
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.router, "5.3.1");
assert.equal(runtime.vue, "3.5.43");
assert.equal(runtime.selectedRouterBytesMatch, true);
const sourceOutput = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs assembly-vue-router",
]);
const lines = sourceOutput.trim().split("\n");
assert.equal(lines.length, 2);
const [cachePreparation, source] = lines.map((line) => JSON.parse(line));
assert.ok(
  cachePreparation.lockedRegistryTarballs > 0 && cachePreparation.bytes > 0,
);
assert.equal(cachePreparation.registryMetadataCopied, false);
assert.equal(cachePreparation.historicalLocalPackageTarballsCopied, false);
assert.equal(source.complete, true);
assert.equal(source.passed, 9);
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-vue-router-assembly-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-vue-router-assembly-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 35);
assert.ok(
  guards.controls.every(
    (c) =>
      c.originalPassed &&
      c.mutantCompiled &&
      c.mutantFailedAssertion &&
      c.restoredPassed,
  ),
);
const supplemental = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/review-vue-router-assembly-guards.test.js",
]);
assert.match(supplemental, /# pass 9\n/);
assert.match(supplemental, /# fail 0\n/);
assert.match(supplemental, /# skipped 0\n/);
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-vue-router",
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
    cachePreparation,
    guards,
    supplemental: { passed: 9, failed: 0, skipped: 0 },
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
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
