import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image = process.env.CHECKTRAIL_LARAVEL_ASSEMBLY_IMAGE;
assert.ok(image, "Pass the operator-prepared pinned Laravel assembly image");
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `laravel-assembly-${process.pid}`;
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
const started = Date.now();
const stage = (name) =>
  process.stderr.write(
    JSON.stringify({ stage: name, elapsedMs: Date.now() - started }) + "\n",
  );
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1048576,
    timeout: 900000,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';import{laravelAssemblyRuntimePins,laravelAssemblyVersions}from'./dist/src/laravel-assembly-runtime-pins.js';const vendor='.checktrail/laravel-tools/vendor';const versions=Object.fromEntries(JSON.parse(readFileSync(vendor+'/composer/installed.json','utf8')).packages.filter(p=>Object.hasOwn(laravelAssemblyVersions,p.name)).map(p=>[p.name,p.version]));const selectedRuntimeBytes=laravelAssemblyRuntimePins.map(pin=>{const b=readFileSync(vendor+'/'+pin.directory+'/'+pin.file);const observed={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};return{...pin,observed,matches:observed.bytes===pin.bytes&&observed.sha256===pin.sha256};});const p=spawnSync('php',['-r','echo json_encode(["php"=>PHP_VERSION,"sqlite"=>in_array("sqlite",PDO::getAvailableDrivers(),true)]);'],{encoding:'utf8'});if(p.status!==0)throw Error('Native PHP identity failed');const b=readFileSync(process.execPath);console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,nodeBinary:{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')},...JSON.parse(p.stdout),versions,selectedRuntimeBytes,os:readFileSync('/etc/os-release','utf8')}));`,
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.php, "8.5.6");
assert.equal(runtime.sqlite, true);
assert.deepEqual(runtime.versions, {
  "laravel/framework": "v13.32.0",
  "nesbot/carbon": "3.14.0",
  "symfony/http-foundation": "v8.1.7",
  "symfony/routing": "v8.1.6",
});
assert.ok(runtime.selectedRuntimeBytes.every((p) => p.matches));
stage("legacy");
const legacy = JSON.parse(
  run([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "laravel",
    "laravel-cache",
  ]),
);
assert.equal(legacy.required, 9);
assert.equal(legacy.passed, 9);
assert.equal(legacy.complete, true);
stage("source");
const sourceLines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs assembly-laravel",
])
  .trim()
  .split("\n");
assert.equal(sourceLines.length, 2);
const preparedCache = JSON.parse(sourceLines[0]);
const source = JSON.parse(sourceLines[1]);
assert.equal(source.passed, 9);
assert.equal(source.complete, true);
stage("controls");
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-laravel-assembly-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-laravel-assembly-guards.mjs",
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
stage("supplemental");
const supplemental = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/review-laravel-assembly-guards.test.js",
  "dist/test/process-tree.test.js",
]);
assert.match(supplemental, /# pass 16\n/);
assert.match(supplemental, /# fail 0\n/);
assert.match(supplemental, /# skipped 0\n/);
stage("installed");
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-laravel",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
      timeout: 300000,
    },
  ),
);
assert.equal(installed.profile.passed, 9);
assert.equal(installed.profile.complete, true);
stage("complete");
process.stdout.write(
  JSON.stringify({
    runtime,
    image,
    legacy,
    preparedCache,
    source,
    guards,
    supplemental: { passed: 16, failed: 0, skipped: 0 },
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
