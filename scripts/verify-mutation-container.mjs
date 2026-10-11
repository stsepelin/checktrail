import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const phase = process.argv[2] ?? "all";
assert.ok(["all", "acceptance", "guards"].includes(phase));
const family = process.env.CHECKTRAIL_MUTATION_FAMILY;
assert.ok(["vitest", "jest", "pytest", "phpunit"].includes(family));
const selected = process.env.CHECKTRAIL_MUTATION_IMAGE;
assert.ok(selected, "Pass the operator-prepared native mutation image");
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `mutation-${family}-${process.pid}`;
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
  "3g",
  "--pids-limit",
  "256",
  "--tmpfs",
  "/tmp:rw,exec,nosuid,nodev,size=2048m",
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
  "--env",
  "CHECKTRAIL_MUTATION_FAMILY=" + family,
  "--env",
  "CHECKTRAIL_MUTATION_INSTALL_RECEIPT=/tmp/installed.json",
  "--env",
  "CHECKTRAIL_MUTATION_LIFECYCLE_RECEIPT=/tmp/lifecycle.json",
  image,
];
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    timeout: 2100000,
    maxBuffer: 8 * 1048576,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    `import{createHash}from'node:crypto';import{readFileSync}from'node:fs';console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,sha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}));`,
  ]),
);
assert.equal(runtime.version, "22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
let acceptance;
if (phase !== "guards") {
  const packets = run([
    "sh",
    "-c",
    'set -eu; node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache; node scripts/verify-required-native-tests.mjs "$1"; cat /tmp/installed.json /tmp/lifecycle.json /tmp/lifecycle.json.installed',
    "native-mutations",
    "mutation-" + family,
  ])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(packets.length, 5);
  const [
    preparedCache,
    source,
    installed,
    sourceLifecycle,
    installedLifecycle,
  ] = packets;
  const inventory = JSON.parse(
    await readFile(
      new URL("required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
  const frozen = JSON.parse(
    await readFile(
      new URL("../docs/gate-a-profiles.v1.json", import.meta.url),
      "utf8",
    ),
  ).extensionProfiles.find((p) => p.id === "mutation-runners");
  assert.deepEqual(
    inventory["mutation-" + family],
    frozen.acceptanceCases.map((c) => ({
      file: frozen.acceptanceFile,
      name: c.name,
    })),
  );
  assert.equal(source.profile, "mutation-" + family);
  for (const receipt of [source, installed.profile]) {
    assert.equal(receipt.required, 9);
    assert.equal(receipt.passed, 9);
    assert.equal(receipt.complete, true);
    assert.equal(receipt.ledger.truncated, false);
    assert.equal(receipt.ledger.cases.length, 9);
    assert.ok(receipt.ledger.cases.every((c) => c.outcome === "passed"));
  }
  assert.equal(installed.family, family);
  assert.equal(installed.offlineProductionInstall, true);
  assert.equal(installed.harnessOutsideInstalledPackage, true);
  for (const [stage, lifecycle] of [
    ["source", sourceLifecycle],
    ["installed", installedLifecycle],
  ]) {
    assert.equal(lifecycle.family, family);
    assert.equal(lifecycle.stage, stage);
    assert.deepEqual(lifecycle.controls.map((c) => c.kind).sort(), [
      "cancel",
      "dependency",
      "output",
      "source",
      "timeout",
    ]);
    for (const c of lifecycle.controls) {
      assert.equal(c.nativeBodies, 2);
      assert.match(c.nativeExecutableSha256, /^[a-f0-9]{64}$/);
      assert.equal(c.cpuNanoseconds.length, 2);
      assert.ok(
        c.cpuNanoseconds.every((n) => /^[0-9]+$/.test(n) && BigInt(n) > 0n),
      );
    }
  }
  acceptance = {
    preparedCache,
    source,
    installed,
    sourceLifecycle,
    installedLifecycle,
  };
}
let nativeGuards;
if (phase !== "acceptance") {
  nativeGuards = JSON.parse(
    run(["node", "scripts/verify-mutation-guards.mjs", "native"]),
  );
  assert.equal(nativeGuards.family, family);
  assert.equal(nativeGuards.allPaired, true);
  assert.equal(nativeGuards.nativeInvocations, true);
  const controls = JSON.parse(
    await readFile(new URL("mutation-controls.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    nativeGuards.controls.map((c) => c.id),
    controls
      .filter((c) => c.mode === "native" && c.families.includes(family))
      .map((c) => c.id),
  );
}
process.stdout.write(
  JSON.stringify({
    family,
    image,
    runtime,
    phase,
    acceptance,
    nativeGuards,
    wholeProfileRequiresAllFourFamilies: true,
    modelInference: false,
    fieldEvaluation: false,
  }) + "\n",
);
