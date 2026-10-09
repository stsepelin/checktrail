import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selectedImage = process.env.CHECKTRAIL_PHP_EXTENSIONS_IMAGE;
assert.ok(
  selectedImage,
  "Pass the operator-prepared pinned PHP extension image",
);
const image = execFileSync(
  "docker",
  ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `php-extensions-${process.pid}`;
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
  "/tmp:rw,nosuid,nodev,noexec,size=1024m",
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
    timeout: 600000,
    maxBuffer: 4 * 1048576,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{phpExtensionRuntime,phpExtensionToolPins}from'./dist/src/php-extension-pins.js';import{phpExtensionRunner}from'./dist/src/php-extension-runner.js';import{phpExtensionsFlags}from'./dist/src/php-extensions.js';const marker='$transport=json_decode($argv[1],flags:JSON_THROW_ON_ERROR);';const start=phpExtensionRunner.indexOf(marker);if(start<0||phpExtensionRunner.indexOf(marker,start+1)!==-1)throw Error('Exact native runtime capture address');const observed=JSON.parse(execFileSync('php',[...phpExtensionsFlags,phpExtensionRunner.slice(0,start)+'echo json_encode(pe_runtime());'],{encoding:'utf8'}));assert.deepEqual(observed,phpExtensionRuntime,'Native PHP extension closure mismatch');const selectedNativeApis=phpExtensionToolPins.map(pin=>{const data=readFileSync('.checktrail/php-review-tools/vendor/'+pin.path);const observed={bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};return{...pin,observed,matches:observed.bytes===pin.bytes&&observed.sha256===pin.sha256};});if(!selectedNativeApis.every(p=>p.matches))throw Error('Native PHP API bytes mismatch');const node=readFileSync(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:createHash('sha256').update(node).digest('hex')},php:observed,selectedNativeApis,os:readFileSync('/etc/os-release','utf8')}));`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.equal(runtime.php.php, "8.5.6");
assert.equal(runtime.php.architecture, "aarch64");
assert.ok(runtime.selectedNativeApis.every((p) => p.matches));
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
stage("baseline");
const baseline = JSON.parse(
  run([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "php-tools",
    "php-review",
  ]),
);
assert.equal(baseline.required, 14);
assert.equal(baseline.passed, 14);
assert.equal(baseline.complete, true);
stage("source");
const lines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs php-extensions",
])
  .trim()
  .split("\n");
assert.equal(lines.length, 2);
const preparedCache = JSON.parse(lines[0]),
  source = JSON.parse(lines[1]);
assert.equal(source.required, 9);
assert.equal(source.passed, 9);
assert.equal(source.complete, true);
stage("guards");
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-php-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-php-extensions-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 17);
assert.ok(
  guards.controls.every(
    (c) =>
      c.originalPassed &&
      c.mutantCompiled &&
      c.mutantFailedAssertion &&
      c.restoredPassed,
  ),
);
assert.equal(guards.controls.filter((c) => c.phpMutantCompiled).length, 6);
stage("regressions");
const regressions = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/php-extensions.test.js",
  "dist/test/php-extension-planning.test.js",
  "dist/test/schemas.test.js",
]);
assert.match(regressions, /# fail 0\n/);
assert.match(regressions, /# skipped 0\n/);
const count = regressions.match(/# pass (\d+)\n/);
assert.ok(count && Number(count[1]) > 0);
stage("installed");
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "php-extensions",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 4 * 1048576,
    },
  ),
);
assert.equal(installed.profile.required, 9);
assert.equal(installed.profile.passed, 9);
assert.equal(installed.profile.complete, true);
const profiles = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
);
process.stdout.write(
  JSON.stringify({
    runtime,
    image,
    baseline,
    source,
    guards,
    regressions: { passed: Number(count[1]), failed: 0, skipped: 0 },
    installed,
    preparedCache,
    callbacks: profiles["php-extensions"],
    environment: {
      network: "none",
      sourceMount: "readonly",
      rootFilesystemReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 1024,
      temporaryFilesystemExecutable: false,
    },
    nativeExtensionScope:
      "Exact loaded PHP extension identities, mapped extension-directory artifacts and the interpreter binary; system shared libraries remain outside this selected closure.",
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
    finalMatrixAccepted: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
