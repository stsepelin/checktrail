import assert from "node:assert/strict";
import console from "node:console";
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
const root = fileURLToPath(new URL("../", import.meta.url));
const phase = process.argv[2] ?? "all";
assert.ok(
  ["all", "acceptance", "guards-1", "guards-2", "guards-3"].includes(phase),
);
const prepared = JSON.parse(
  await readFile(
    path.join(root, ".checktrail/swift-extensions-runtime/identity.json"),
    "utf8",
  ),
);
assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
const [selected] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.image], {
    encoding: "utf8",
  }),
);
assert.equal(selected.Config.Labels["checktrail.task"], prepared.task);
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
  "3g",
  "--pids-limit",
  "256",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,exec,size=2048m",
  "--label",
  "checktrail.task=" + prepared.task,
  "--mount",
  `type=bind,src=${root},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--env",
  "CHECKTRAIL_SWIFT_EXTENSIONS_SDK=/workspace/.checktrail/swift-extensions-runtime/sdk.json",
  "--env",
  "CHECKTRAIL_SWIFT_TOOLS_NATIVE=1",
  "--workdir",
  "/workspace",
  prepared.image,
];
const invoke = promisify(execFile),
  timings = {},
  started = performance.now();
const measured = async (name, action) => {
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
  const start = performance.now();
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
const run = async (args) => {
  try {
    return (
      await invoke("docker", [...base, ...args], {
        encoding: "utf8",
        timeout: 2400000,
        maxBuffer: 16 * 1048576,
      })
    ).stdout;
  } catch (error) {
    throw Error(
      "Swift extension acceptance stage failed: " +
        String(error.stderr || error.stdout || error.message).slice(-4000),
      { cause: error },
    );
  }
};
const runtime = JSON.parse(
  await run([
    "node",
    "--input-type=module",
    "-e",
    `import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';const names=['swift','swiftc','swift-frontend','swiftlint'];const tools=[];for(const name of names){const file=execFileSync('which',[name],{encoding:'utf8'}).trim();const bytes=await readFile(file);tools.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}const node=await readFile(process.execPath);console.log(JSON.stringify({node:{version:process.version,platform:process.platform,arch:process.arch,bytes:node.length,sha256:createHash('sha256').update(node).digest('hex')},swift:execFileSync('swiftc',['--version'],{encoding:'utf8'}).trim(),swiftpm:execFileSync('swift',['package','--version'],{encoding:'utf8'}).trim(),swiftlint:execFileSync('swiftlint',['version'],{encoding:'utf8'}).trim(),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),tools,os:await readFile('/etc/os-release','utf8')}));`,
  ]),
);
assert.equal(runtime.node.version, "v22.23.2");
assert.equal(runtime.node.platform, "linux");
assert.equal(runtime.node.arch, "arm64");
assert.match(runtime.swift, /^Swift version 6\.2\.3 /);
assert.equal(runtime.swiftpm, "Swift Package Manager - Swift 6.2.3");
assert.equal(runtime.swiftlint, "0.65.1");
assert.equal(runtime.npm, "10.9.8");
const requirements = JSON.parse(
  await readFile(path.join(root, "scripts/required-native-tests.json"), "utf8"),
);
const baselineProfiles = ["swift", "swift-tools"];
const baseline = () =>
  measured("preserved-swift-tools-baseline", async () => {
    const result = JSON.parse(
      await run([
        "node",
        "scripts/verify-required-native-tests.mjs",
        ...baselineProfiles,
      ]),
    );
    assert.equal(
      result.required,
      baselineProfiles.reduce((n, p) => n + requirements[p].length, 0),
    );
    assert.equal(result.complete, true);
    assert.equal(result.ledger.cases.length, result.required);
    assert.ok(
      result.ledger.cases.every(
        (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
      ),
    );
    return result;
  });
const acceptance = () =>
  measured("source-and-fresh-offline-production-installation", async () => {
    const lines = (
      await run([
        "sh",
        "-c",
        "set -eu; node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache; CHECKTRAIL_SWIFT_EXTENSIONS_INSTALL_RECEIPT=/tmp/installed-receipt.json node scripts/verify-required-native-tests.mjs swift-extensions; cat /tmp/installed-receipt.json",
      ])
    )
      .trim()
      .split("\n");
    assert.equal(lines.length, 3);
    const preparedCache = JSON.parse(lines[0]),
      source = JSON.parse(lines[1]),
      installed = JSON.parse(lines[2]);
    for (const result of [source, installed.profile]) {
      assert.equal(result.required, 9);
      assert.equal(result.passed, 9);
      assert.equal(result.complete, true);
      assert.equal(result.ledger.cases.length, 9);
      assert.ok(
        result.ledger.cases.every(
          (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
        ),
      );
    }
    assert.equal(installed.offlineProductionInstall, true);
    assert.equal(installed.harnessOutsideInstalledPackage, true);
    return { preparedCache, source, installed };
  });
const guards = (shard) =>
  measured("paired-guards-" + shard, async () => {
    const result = JSON.parse(
      await run([
        "sh",
        "-c",
        "set -eu; mkdir /tmp/guards; cp -R dist examples /tmp/guards/; mkdir /tmp/guards/scripts; cp scripts/verify-swift-extensions-guards.mjs package.json /tmp/guards/; mv /tmp/guards/verify-swift-extensions-guards.mjs /tmp/guards/scripts/; ln -s /workspace/node_modules /tmp/guards/node_modules; cd /tmp/guards; node scripts/verify-swift-extensions-guards.mjs " +
          shard,
      ]),
    );
    assert.equal(result.allComplete, true);
    assert.equal(result.sourceRestored, true);
    assert.equal(result.callbacksUnchanged, true);
    assert.equal(result.fixturesUnchanged, true);
    assert.equal(result.fullControlInventory.length, 15);
    assert.equal(new Set(result.fullControlInventory).size, 15);
    assert.equal(result.controls.length, shard === "all" ? 15 : 5);
    assert.equal(
      new Set(result.controls.map((c) => c.id)).size,
      result.controls.length,
    );
    assert.equal(
      result.controls.filter(
        (c) => c.nativeTestBodiesReachedUnderMutatedInvocation,
      ).length,
      shard === "all" ? 3 : 1,
    );
    return result;
  });
let result;
if (phase === "all") {
  // Baseline and source/install each use a new read-only container in this branch.
  // The second branch mutates only a private /tmp copy: at most two containers.
  const groups = await Promise.allSettled([
    (async () => ({ baseline: await baseline(), ...(await acceptance()) }))(),
    guards("all"),
  ]);
  const failures = groups.filter((g) => g.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((g) => g.reason),
      "Required Swift native groups failed",
    );
  result = { ...groups[0].value, guards: groups[1].value };
} else if (phase === "acceptance") {
  const groups = await Promise.allSettled([baseline(), acceptance()]);
  const failures = groups.filter((g) => g.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((g) => g.reason),
      "Required Swift native groups failed",
    );
  result = { baseline: groups[0].value, ...groups[1].value };
} else result = { guards: await guards(phase.slice(-1)) };
console.log(
  JSON.stringify({
    schemaVersion: 1,
    profile: "swift-extensions",
    phase,
    image: prepared.image,
    runtime,
    baselineProfiles,
    ...result,
    environment: {
      network: "none",
      readOnlyRoot: true,
      user: "1000:1000",
      cpuLimit: 2,
      memoryBytes: 3 * 1024 * 1024 * 1024,
      pidLimit: 256,
      tmpfsBytes: 2 * 1024 * 1024 * 1024,
    },
    concurrency: {
      maxNativeContainers: phase.startsWith("guards-") ? 1 : 2,
      aggregateCpuLimit: phase.startsWith("guards-") ? 2 : 4,
      aggregateMemoryBytes:
        (phase.startsWith("guards-") ? 3 : 6) * 1024 * 1024 * 1024,
      sharedWritableFixtures: false,
    },
    stageDurationMs: timings,
    durationMs: Math.round(performance.now() - started),
    complete: true,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    qualityAssessed: false,
    wholeRuntimeClosureVerified: false,
    platformMatrixComplete: false,
    gateAComplete: false,
  }),
);
