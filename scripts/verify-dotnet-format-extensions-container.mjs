import assert from "node:assert/strict";
import console from "node:console";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  selected =
    process.env.CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_IMAGE ??
    "checktrail-dotnet-format-extensions:10.0.401",
  task = process.env.CHECKTRAIL_TEST_TASK;
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const cache = execFileSync("npm", ["config", "get", "cache"], {
    encoding: "utf8",
  }).trim(),
  dependencies = await (
    await import("node:fs/promises")
  ).realpath(
    process.env.CHECKTRAIL_DOTNET_BUILD_CACHE ??
      path.join(repository, ".checktrail/dotnet-build-dependencies"),
  );
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
  ...(task ? ["--label", "checktrail.task=" + task] : []),
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--mount",
  `type=bind,src=${dependencies},target=/dependencies,readonly`,
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--env",
  "CHECKTRAIL_DOTNET_BUILD_CACHE=/dependencies",
  "--workdir",
  "/workspace",
  image,
];
const invoke = promisify(execFile);
const run = async (args) => {
  try {
    return (
      await invoke("docker", [...base, ...args], {
        encoding: "utf8",
        timeout: 1800000,
        maxBuffer: 16 * 1048576,
      })
    ).stdout;
  } catch (error) {
    throw Error(
      ".NET formatting acceptance stage failed: " +
        String(error.stderr || error.stdout || error.message).slice(-3000),
      { cause: error },
    );
  }
};
const timings = {};
const measured = async (name, action) => {
  const start = performance.now();
  stage(name);
  try {
    return await action();
  } finally {
    timings[name] = Math.round(performance.now() - start);
    process.stderr.write(
      JSON.stringify({ stageCompleted: name, durationMs: timings[name] }) +
        "\n",
    );
  }
};
const stage = (name) =>
    process.stderr.write(JSON.stringify({ stage: name }) + "\n"),
  started = performance.now();
stage("selected-runtime-and-sdk-formatter-components");
const runtime = JSON.parse(
  await run([
    "node",
    "--input-type=module",
    "-e",
    `
import assert from 'node:assert/strict';import {realpath,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {verifyDotnetFormatterSdk} from './dist/src/dotnet-format-extensions.js';import {fsharpSdkPins} from './dist/src/fsharp-format-pins.js';import {dotnetFormatterSdkPins,dotnetFormatterRuleCatalogue} from './dist/src/dotnet-formatter-pins.js';
const tool=await realpath('/usr/bin/dotnet').catch(()=>realpath('/usr/share/dotnet/dotnet')),sdkRoot=tool.slice(0,tool.lastIndexOf('/'));assert.equal(await verifyDotnetFormatterSdk(sdkRoot),tool);const selected=new Map();for(const pin of [...fsharpSdkPins,...dotnetFormatterSdkPins]){if(selected.has(pin.file))assert.deepEqual(selected.get(pin.file),pin);selected.set(pin.file,pin);}const union=[...selected.values()].sort((a,b)=>a.file.localeCompare(b.file)),bytes=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},sdk:{version:'10.0.401',runtime:'10.0.12',selectedComponents:union.length,selectedBytes:union.reduce((n,p)=>n+p.bytes,0),runtimeAndCompilerComponents:fsharpSdkPins.length,formattingComponents:dotnetFormatterSdkPins.length,pinsSha256:createHash('sha256').update(JSON.stringify(union)).digest('hex'),byteVerified:true,wholeClosureVerified:false},formatter:{catalogue:Object.fromEntries(Object.entries(dotnetFormatterRuleCatalogue).map(([mode,languages])=>[mode,Object.fromEntries(Object.entries(languages).map(([language,ids])=>[language,ids.length]))])),generatedSemanticFixesSupported:false},os:await readFile('/etc/os-release','utf8')}));
`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
const npmVersion = (await run(["npm", "--version"])).trim();
assert.match(npmVersion, /^\d+\.\d+\.\d+$/);
runtime.npm = { version: npmVersion };
const requirements = JSON.parse(
    await readFile(
      path.join(repository, "scripts/required-native-tests.json"),
      "utf8",
    ),
  ),
  baselineProfiles = ["dotnet-build", "dotnet-format", "dotnet-generated"];
// The guard driver mutates only its own /tmp copy. Baseline and source/install
// use separate read-only containers and fresh fixtures; none shares a writable
// workspace or npm cache. Two concurrent containers cap resources at 4 CPUs/8 GiB.
const groups = await Promise.allSettled([
  (async () => {
    const baseline = await measured(
      "preserved-dotnet-build-whitespace-and-generated-sources",
      async () => {
        const baseline = JSON.parse(
          await run([
            "node",
            "scripts/verify-required-native-tests.mjs",
            ...baselineProfiles,
          ]),
        );
        assert.equal(
          baseline.required,
          baselineProfiles.reduce((n, p) => n + requirements[p].length, 0),
        );
        assert.equal(baseline.complete, true);
        assert.equal(baseline.ledger.cases.length, baseline.required);
        assert.ok(
          baseline.ledger.cases.every(
            (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
          ),
        );
        return baseline;
      },
    );
    const acceptance = await measured(
      "source-and-fresh-offline-production-installation",
      async () => {
        const lines = (
          await run([
            "sh",
            "-c",
            "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && CHECKTRAIL_DOTNET_FORMAT_EXTENSIONS_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs dotnet-format-extensions && cat /tmp/installed-receipt.json",
          ])
        )
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
        assert.equal(installed.offlineProductionInstall, true);
        assert.equal(installed.harnessOutsideInstalledPackage, true);
        return { preparedCache, source, installed };
      },
    );
    return { baseline, ...acceptance };
  })(),
  measured("compiling-guards-and-native-observer-mutations", async () => {
    const guards = JSON.parse(
      await run([
        "sh",
        "-c",
        "mkdir /tmp/guards && cp -R dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-dotnet-format-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && cd /tmp/guards && node scripts/verify-dotnet-format-extensions-guards.mjs",
      ]),
    );
    assert.equal(guards.controls.length, 20);
    assert.equal(guards.allComplete, true);
    assert.equal(guards.sourceRestored, true);
    assert.equal(guards.callbacksUnchanged, true);
    assert.equal(guards.fixturesUnchanged, true);
    assert.equal(
      guards.controls.filter((c) => c.mutatedNativeObserverCompiled).length,
      4,
    );
    return guards;
  }),
]);
const failures = groups.filter((group) => group.status === "rejected");
if (failures.length)
  throw new AggregateError(
    failures.map((group) => group.reason),
    "Required native acceptance groups failed",
  );
const { baseline, preparedCache, source, installed } = groups[0].value,
  guards = groups[1].value;
console.log(
  JSON.stringify({
    schemaVersion: 1,
    profile: "dotnet-format-extensions",
    runtime,
    environment: {
      network: "none",
      readOnlyRoot: true,
      user: "1000:1000",
      cpuLimit: 2,
      memoryBytes: 4 * 1024 * 1024 * 1024,
      pidLimit: 256,
      tmpfsBytes: 2 * 1024 * 1024 * 1024,
    },
    concurrency: {
      maxNativeContainers: 2,
      aggregateCpuLimit: 4,
      aggregateMemoryBytes: 8 * 1024 * 1024 * 1024,
      aggregatePidLimit: 512,
      aggregateTmpfsBytes: 4 * 1024 * 1024 * 1024,
      sharedWritableFixtures: false,
    },
    stageDurationMs: timings,
    baselineProfiles,
    baseline,
    preparedCache,
    source,
    installed,
    guards,
    durationMs: Math.round(performance.now() - started),
    complete: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    wholeRuntimeClosureVerified: false,
    platformMatrixComplete: false,
    gateAComplete: false,
  }),
);
