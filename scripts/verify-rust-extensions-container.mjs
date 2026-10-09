import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selectedImage = process.env.CHECKTRAIL_RUST_EXTENSIONS_IMAGE;
assert.ok(
  selectedImage,
  "Pass the operator-prepared pinned Rust extension image",
);
const image = execFileSync(
  "docker",
  ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `rust-extensions-${process.pid}`;
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
  "/tmp:rw,nosuid,nodev,exec,size=1024m",
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
    `import assert from'node:assert/strict';import{readFileSync,readlinkSync,lstatSync}from'node:fs';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{rustNativeToolchainPins}from'./dist/src/rust-toolchain-pins.js';import{rustNativeToolchainMatches}from'./dist/src/rust-toolchain-native.js';assert.equal(await rustNativeToolchainMatches(),true);const tools=Object.fromEntries(['rustc','cargo','cargo-clippy','rustdoc','rustfmt','cc'].map(name=>[name,execFileSync(name,['--version'],{encoding:'utf8'}).trim()]));const nativeArtifacts=rustNativeToolchainPins.map(pin=>{const file='/opt/checktrail-rust/'+pin.path;const b=readFileSync(file);const observed={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),link:lstatSync(file).isSymbolicLink()?readlinkSync(file):null};return{...pin,observed,matches:pin.bytes===observed.bytes&&pin.sha256===observed.sha256&&pin.link===observed.link};});const b=readFileSync(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')},tools,nativeArtifacts,os:readFileSync('/etc/os-release','utf8')}));`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.match(runtime.tools.rustc, /^rustc 1\.98\.1 /);
assert.equal(runtime.nativeArtifacts.length, 16);
assert.ok(runtime.nativeArtifacts.every((p) => p.matches));
const components = JSON.parse(
  await readFile(
    path.join(repository, "scripts/rust-extension-components.json"),
    "utf8",
  ),
);
const archiveIdentity = await Promise.all(
  components.records.map(async (p) => {
    const b = await readFile(
      path.join(repository, ".checktrail/rust-extension-components", p.file),
    );
    assert.equal(b.length, p.bytes);
    assert.equal(createHash("sha256").update(b).digest("hex"), p.sha256);
    return { ...p, bytesVerified: true };
  }),
);
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
stage("archive-preflight");
const preflight = execFileSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "dist/test/rust-component-preflight.test.js",
  ],
  { cwd: repository, encoding: "utf8", timeout: 30000 },
);
assert.match(preflight, /# pass 2\n/);
assert.match(preflight, /# fail 0\n/);
assert.match(preflight, /# skipped 0\n/);
const archivePreflight = {
  passed: 2,
  failed: 0,
  skipped: 0,
  diagnosticSha256: createHash("sha256").update(preflight).digest("hex"),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
  },
  executedOutsideNativeImage: true,
};
stage("baseline");
const baseline = JSON.parse(
  run([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "rust",
    "rust-format",
    "clippy",
    "rust-tests",
    "rust-workspace",
  ]),
);
assert.equal(baseline.required, 39);
assert.equal(baseline.passed, 39);
assert.equal(baseline.complete, true);
stage("source");
const lines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs rust-extensions",
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
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-rust-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-rust-extensions-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 15);
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
  "dist/test/rust-extensions.test.js",
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
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "rust-extensions",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      timeout: 480000,
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
    callbacks: profiles["rust-extensions"],
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
    archiveIdentity,
    archivePreflight,
    nativeExtensionScope:
      "Six exact official component archives and sixteen selected GNU ARM64 compiler, driver, host and foreign standard-library artifacts; system libraries, Cargo configuration, generated content, publisher and whole dependency closure remain outside this selection.",
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
    finalMatrixAccepted: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
