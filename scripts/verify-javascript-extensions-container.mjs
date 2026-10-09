import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image =
  "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `javascript-extensions-${process.pid}`;
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const native = path.join(
  repository,
  ".checktrail/javascript-tools/node_modules",
);
const prepared = await access(native).then(
  () => true,
  () => false,
);
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
  "/tmp:rw,exec,nosuid,nodev,size=1024m",
  "--label",
  "checktrail.task=" + task,
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  ...(prepared
    ? [
        "--mount",
        `type=bind,src=${native},target=/workspace/node_modules,readonly`,
      ]
    : []),
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
    timeout: 600000,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';import{viteLibraryPrerequisites}from'./dist/src/vite-library-prerequisites.js';import{eslintParticipationPrerequisites}from'./dist/src/eslint-participation-prerequisites.js';const b=readFileSync(process.execPath);console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,nodeBinary:{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')},os:readFileSync('/etc/os-release','utf8'),eslint:await eslintParticipationPrerequisites('/workspace','/workspace/node_modules/eslint/lib/api.js'),library:await viteLibraryPrerequisites('/workspace','/workspace/node_modules/vite/dist/node/index.js','/workspace/node_modules/typescript/lib/typescript.js')}));`,
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.eslint.available, true);
assert.equal(runtime.library.available, true);
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
stage("source");
const lines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs javascript-extensions",
])
  .trim()
  .split("\n");
assert.equal(lines.length, 2);
const preparedCache = JSON.parse(lines[0]);
const source = JSON.parse(lines[1]);
assert.equal(source.required, 9);
assert.equal(source.passed, 9);
assert.equal(source.complete, true);
stage("guards");
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-javascript-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-javascript-extensions-guards.mjs",
  ]),
);
assert.ok(guards.controls.length > 0);
assert.ok(
  guards.controls.every(
    (c) =>
      c.originalPassed &&
      c.mutantCompiled &&
      c.mutantFailedAssertion &&
      c.restoredPassed,
  ),
);
stage("regressions");
const regressions = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/eslint.test.js",
  "dist/test/eslint-participation.test.js",
  "dist/test/node-loaders.test.js",
  "dist/test/vite-library.test.js",
  "dist/test/typescript-build.test.js",
]);
assert.match(regressions, /# fail 0\n/);
assert.match(regressions, /# skipped 0\n/);
const match = regressions.match(/# pass (\d+)\n/);
assert.ok(match);
stage("installed");
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "javascript-extensions",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
      timeout: 300000,
    },
  ),
);
assert.equal(installed.profile.required, 9);
assert.equal(installed.profile.passed, 9);
assert.equal(installed.profile.complete, true);
const sourcePins = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
)["javascript-extensions"];
process.stdout.write(
  JSON.stringify({
    runtime,
    image,
    preparedCache,
    source,
    guards,
    regressions: { passed: Number(match[1]), failed: 0, skipped: 0 },
    installed,
    callbacks: sourcePins,
    environment: {
      network: "none",
      sourceMount: "readonly",
      rootFilesystemReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 1024,
      temporaryFilesystemExecutable: true,
    },
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
    gateAComplete: false,
    finalMatrixAccepted: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
