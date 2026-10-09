import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const image =
  "public.ecr.aws/docker/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const phase = process.argv[2] ?? "all";
assert.equal(process.argv.length <= 3, true);
assert.ok(
  ["all", "acceptance", "guards-1", "guards-2", "guards-3"].includes(phase),
  "Unknown Nuxt acceptance phase",
);
const manifest = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-nuxt-assembly-guards.mjs", "--list"],
    { cwd: repository, encoding: "utf8" },
  ),
);
assert.equal(manifest.ids.length, 31);
assert.equal(new Set(manifest.ids).size, 31);
assert.deepEqual(manifest.shards.flat().sort(), [...manifest.ids].sort());
assert.ok(manifest.shards.every((ids) => ids.length > 0));
const selectedControls = phase.startsWith("guards-")
  ? manifest.shards[Number(phase.slice(-1)) - 1]
  : manifest.ids;
const phaseStarted = Date.now();
const stage = (name) =>
  process.stderr.write(
    JSON.stringify({
      phase,
      stage: name,
      elapsedMs: Date.now() - phaseStarted,
    }) + "\n",
  );
const task = process.env.CHECKTRAIL_TEST_TASK ?? `nuxt-assembly-${process.pid}`;
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
    maxBuffer: 4 * 1048576,
    timeout: 900000,
  });
const prepared = path.join(
  repository,
  ".checktrail",
  process.platform === "darwin" ? "nuxt-linux-tools" : "nuxt-tools",
);
await access(path.join(prepared, "node_modules/nuxt/package.json"));
base.splice(
  base.indexOf("--workdir"),
  0,
  "--mount",
  `type=bind,src=${prepared},target=/workspace/.checktrail/nuxt-tools,readonly`,
);
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import{readFileSync,realpathSync}from'node:fs';import{createHash}from'node:crypto';import{createRequire}from'node:module';import path from'node:path';import{nuxtAssemblyRuntimePins}from'./dist/src/nuxt-assembly-runtime-pins.js';import{nuxtVersions}from'./dist/src/nuxt.js';const resolver=createRequire(path.join(process.cwd(),'.checktrail/nuxt-tools/node_modules/nuxt/dist/index.mjs')),metadata={},versions={};for(const n of Object.keys(nuxtVersions)){metadata[n]=(n==='nitropack'?createRequire(metadata['@nuxt/nitro-server']):resolver).resolve(n+'/package.json');}for(const n of ['h3','vite'])metadata[n]=resolver.resolve(n+'/package.json');metadata.typescript=createRequire(import.meta.url).resolve('typescript/package.json');for(const[n,p]of Object.entries(metadata))versions[n]=JSON.parse(readFileSync(p,'utf8')).version;const selectedRuntimeBytes=nuxtAssemblyRuntimePins.map(pin=>{const b=readFileSync(path.join(path.dirname(realpathSync(metadata[pin.package])),pin.file));return{...pin,observed:{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')},matches:b.length===pin.bytes&&createHash('sha256').update(b).digest('hex')===pin.sha256};});const b=readFileSync(process.execPath);console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,versions,os:readFileSync('/etc/os-release','utf8'),nodeBinary:{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')},selectedRuntimeBytes}));`,
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.ok(runtime.selectedRuntimeBytes.every((p) => p.matches));
assert.deepEqual(runtime.versions, {
  nuxt: "4.5.2",
  "@nuxt/kit": "4.5.2",
  "@nuxt/vite-builder": "4.5.2",
  "@nuxt/nitro-server": "4.5.2",
  nitropack: "2.13.4",
  vue: "3.5.43",
  "vue-router": "5.3.1",
  h3: "1.15.11",
  vite: "8.3.0",
  typescript: "6.0.3",
});
let legacy = null,
  source = null,
  cachePreparation = null;
if (phase === "all" || phase === "acceptance") {
  stage("legacy-and-source");
  legacy = JSON.parse(
    run(["node", "scripts/verify-required-native-tests.mjs", "nuxt"]),
  );
  assert.equal(legacy.passed, 7);
  assert.equal(legacy.complete, true);
  const sourceOutput = run([
    "/bin/sh",
    "-c",
    "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs assembly-nuxt",
  ]);
  const lines = sourceOutput.trim().split("\n");
  assert.equal(lines.length, 2);
  [cachePreparation, source] = lines.map((line) => JSON.parse(line));
  assert.ok(
    cachePreparation.lockedRegistryTarballs > 0 && cachePreparation.bytes > 0,
  );
  assert.equal(cachePreparation.registryMetadataCopied, false);
  assert.equal(cachePreparation.historicalLocalPackageTarballsCopied, false);
  assert.equal(source.complete, true);
  assert.equal(source.passed, 9);
}
let guards = null;
if (phase === "all" || phase.startsWith("guards-")) {
  stage("compiling-controls");
  guards = JSON.parse(
    run([
      "/bin/sh",
      "-c",
      "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-nuxt-assembly-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && ln -s /workspace/.checktrail /tmp/guards/.checktrail && cd /tmp/guards && node scripts/verify-nuxt-assembly-guards.mjs " +
        selectedControls.join(" "),
    ]),
  );
  assert.deepEqual(
    guards.controls.map((c) => c.id),
    selectedControls,
  );
  assert.ok(
    guards.controls.every(
      (c) =>
        c.originalPassed &&
        c.mutantCompiled &&
        c.mutantFailedAssertion &&
        c.restoredPassed,
    ),
  );
}
let installed = null;
if (phase === "all" || phase === "acceptance") {
  stage("supplemental-and-installed");
  const supplemental = run([
    "node",
    "--test",
    "--test-reporter=tap",
    "dist/test/review-nuxt-assembly-guards.test.js",
  ]);
  assert.match(supplemental, /# pass 9\n/);
  assert.match(supplemental, /# fail 0\n/);
  assert.match(supplemental, /# skipped 0\n/);
  installed = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/verify-import-context-package.mjs"],
      {
        cwd: repository,
        env: {
          ...process.env,
          CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "assembly-nuxt",
          CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
        },
        encoding: "utf8",
        maxBuffer: 4 * 1048576,
        timeout: 300000,
      },
    ),
  );
  assert.equal(installed.profile.complete, true);
  assert.equal(installed.profile.passed, 9);
}
stage("complete");
process.stdout.write(
  JSON.stringify({
    phase,
    selectedControlIds: guards ? selectedControls : [],
    runtime,
    image,
    legacy,
    source,
    cachePreparation,
    guards,
    supplemental:
      phase === "all" || phase === "acceptance"
        ? { passed: 9, failed: 0, skipped: 0 }
        : null,
    installed,
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
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
