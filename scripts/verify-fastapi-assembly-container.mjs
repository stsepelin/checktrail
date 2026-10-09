import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image = process.env.CHECKTRAIL_FASTAPI_ASSEMBLY_IMAGE;
assert.ok(image, "Pass the operator-prepared FastAPI assembly image");
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `fastapi-assembly-${process.pid}`;
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
    "python3",
    "-I",
    "-c",
    "import json,sys,pathlib,hashlib;from importlib.metadata import version;p=pathlib.Path(sys.executable);b=p.read_bytes();print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'packages':{n:version(n) for n in ['fastapi','starlette','pydantic']},'pythonBinary':{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()},'os':pathlib.Path('/etc/os-release').read_text()}))",
  ]),
);
assert.equal(runtime.python, "3.12.13");
assert.deepEqual(runtime.packages, {
  fastapi: "0.141.1",
  starlette: "1.6.0",
  pydantic: "2.13.5",
});
const node = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";const b=readFileSync(process.execPath);console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,binary:{bytes:b.length,sha256:createHash("sha256").update(b).digest("hex")}}));',
  ]),
);
assert.equal(node.version, "v22.23.2");
assert.equal(node.platform, "linux");
assert.equal(node.arch, "arm64");
const legacy = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/fastapi.test.js",
  "dist/test/fastapi-evidence.test.js",
]);
assert.match(legacy, /# fail 0\n/);
assert.match(legacy, /# skipped 0\n/);
assert.match(legacy, /# pass [1-9][0-9]*\n/);
const frameworks = JSON.parse(
  run(["node", "scripts/verify-required-native-tests.mjs", "frameworks"]),
);
assert.equal(frameworks.required, 8);
assert.equal(frameworks.passed, 8);
assert.equal(frameworks.complete, true);
const sourceOutput = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs assembly-fastapi",
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
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-fastapi-assembly-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-fastapi-assembly-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 37);
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
  "dist/test/review-fastapi-assembly-guards.test.js",
]);
assert.match(supplemental, /# pass 10\n/);
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
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-fastapi",
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
    node,
    legacy: { failed: 0, skipped: 0 },
    frameworks,
    image,
    source,
    cachePreparation,
    guards,
    supplemental: { passed: 10, failed: 0, skipped: 0 },
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
