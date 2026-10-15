import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";
const root = fileURLToPath(new URL("../", import.meta.url)),
  phase = process.argv[2] ?? "all";
assert.ok(
  ["all", "baseline", "acceptance", "guards-1", "guards-2"].includes(phase),
);
const prepared = JSON.parse(
  await readFile(
    path.join(root, ".checktrail/cpp-extensions-runtime/identity.json"),
    "utf8",
  ),
);
assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
const [image] = JSON.parse(
  execFileSync("docker", ["image", "inspect", prepared.image], {
    encoding: "utf8",
  }),
);
assert.equal(image.Config.Labels["checktrail.task"], prepared.task);
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
  "--workdir",
  "/workspace",
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  "--env",
  "CHECKTRAIL_CPP_EXTENSIONS_NATIVE=1",
  "--env",
  "CHECKTRAIL_CPP_TOOLS_NATIVE=1",
  "--env",
  "CHECKTRAIL_CPP_EXTENSIONS_SDK=/workspace/.checktrail/cpp-extensions-runtime/sdk.json",
  prepared.image,
];
const started = performance.now(),
  timings = {},
  requirements = JSON.parse(
    await readFile(
      path.join(root, "scripts/required-native-tests.json"),
      "utf8",
    ),
  );
const run = (command) =>
  execFileSync("docker", [...base, "sh", "-c", command], {
    encoding: "utf8",
    timeout: 1200000,
    maxBuffer: 16 * 1048576,
  });
const measured = (name, fn) => {
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
  const start = performance.now();
  try {
    return fn();
  } finally {
    timings[name] = Math.round(performance.now() - start);
    process.stderr.write(
      JSON.stringify({ stageCompleted: name, durationMs: timings[name] }) +
        "\n",
    );
  }
};
const complete = (r, profile) => {
  assert.equal(r.complete, true);
  assert.equal(r.required, requirements[profile].length);
  const expectedExtra =
    profile === "cpp-tools"
      ? [
          "C/C++ planning is data only and rejects undeclared CMake commands and missing source scope",
        ]
      : [];
  const extra = r.ledger.events.filter((e) => e.kind === "test" && !e.required);
  assert.deepEqual(
    extra.map((e) => e.name),
    expectedExtra,
  );
  assert.equal(r.passed, r.required + expectedExtra.length);
  assert.equal(r.ledger.terminalEventCount, r.required + expectedExtra.length);
  assert.equal(r.ledger.events.length, r.ledger.terminalEventCount);
  assert.ok(
    r.ledger.events.every((e) => e.outcome === "passed" && !e.nameTruncated),
  );
  assert.equal(r.ledger.cases.length, r.required);
  assert.ok(
    r.ledger.cases.every(
      (c) => c.outcome === "passed" && c.terminalSequences.length === 1,
    ),
  );
};
const result = {};
if (phase === "all" || phase === "baseline")
  result.preserved = measured(
    "preserved-native-source-and-installation",
    () => {
      const lines = run(
        "set -eu; node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache; node scripts/verify-required-native-tests.mjs cpp-tools; node scripts/verify-cpp-tools-package.mjs",
      )
        .trim()
        .split("\n");
      assert.equal(lines.length, 3);
      const cache = JSON.parse(lines[0]),
        source = JSON.parse(lines[1]),
        installed = JSON.parse(lines[2]);
      complete(source, "cpp-tools");
      complete(installed.profile, "cpp-tools");
      assert.equal(installed.offlineProductionInstall, true);
      assert.equal(installed.harnessOutsideInstalledPackage, true);
      return { cache, source, installed };
    },
  );
if (phase === "all" || phase === "acceptance")
  result.acceptance = measured(
    "source-and-fresh-production-installation",
    () => {
      const lines = run(
        "set -eu; node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache; CHECKTRAIL_CPP_EXTENSIONS_INSTALL_RECEIPT=/tmp/installed.json node scripts/verify-required-native-tests.mjs cpp-extensions; cat /tmp/installed.json",
      )
        .trim()
        .split("\n");
      assert.equal(lines.length, 3);
      const cache = JSON.parse(lines[0]),
        source = JSON.parse(lines[1]),
        installed = JSON.parse(lines[2]);
      complete(source, "cpp-extensions");
      complete(installed.profile, "cpp-extensions");
      assert.equal(installed.offlineProductionInstall, true);
      assert.equal(installed.harnessOutsideInstalledPackage, true);
      return { cache, source, installed };
    },
  );
const hash = (value) => createHash("sha256").update(value).digest("hex");
const controls = JSON.parse(
  await readFile(
    path.join(root, "scripts/cpp-extensions-controls.json"),
    "utf8",
  ),
);
assert.equal(new Set(controls.map((c) => c.id)).size, controls.length);
const sourceHashes = new Map();
for (const c of controls)
  sourceHashes.set(
    c.file,
    hash(await readFile(path.join(root, "dist/src", c.file))),
  );
const callbackHash = hash(
  await readFile(path.join(root, "dist/test/gate-cpp-extensions.test.js")),
);
const fixtureHash = hash(
  await readFile(path.join(root, "dist/test/cpp-extensions-fixture.js")),
);
for (const shard of ["1", "2"])
  if (phase === "all" || phase === "guards-" + shard)
    result["guards-" + shard] = measured("paired-guards-" + shard, () => {
      const r = JSON.parse(
        run(
          "set -eu; mkdir /tmp/guards; cp -R dist /tmp/guards/; cp package.json /tmp/guards/; mkdir /tmp/guards/scripts; cp scripts/verify-cpp-extensions-guards.mjs scripts/cpp-extensions-controls.json /tmp/guards/scripts/; ln -s /workspace/node_modules /tmp/guards/node_modules; cd /tmp/guards; node scripts/verify-cpp-extensions-guards.mjs " +
            shard,
        ),
      );
      for (const key of [
        "allComplete",
        "sourceRestored",
        "callbacksUnchanged",
        "fixturesUnchanged",
        "nativeCppExecutionReached",
      ])
        assert.equal(r[key], true);
      assert.equal(r.inferenceInvoked, false);
      assert.equal(r.fieldEvaluationExecuted, false);
      assert.deepEqual(
        r.fullControlInventory,
        controls.map((c) => c.id),
      );
      const expected = controls.filter((_, i) => i % 2 === Number(shard) - 1);
      assert.deepEqual(
        r.controls.map((c) => c.id),
        expected.map((c) => c.id),
      );
      assert.deepEqual(r.callbacks, [
        { file: "gate-cpp-extensions.test.js", sha256: callbackHash },
      ]);
      assert.deepEqual(r.fixtures, [
        { file: "cpp-extensions-fixture.js", sha256: fixtureHash },
      ]);
      for (const c of r.controls) {
        assert.equal(
          c.originalSha256,
          sourceHashes.get(expected.find((e) => e.id === c.id).file),
        );
        for (const key of [
          "originalPassed",
          "mutantJavaScriptSyntaxChecked",
          "mutantFailedAssertion",
          "restoredPassed",
        ])
          assert.equal(c[key], true);
        assert.equal(c.expressionsReplaced, 1);
        assert.match(c.originalSha256, /^[a-f0-9]{64}$/);
        assert.match(c.mutantSha256, /^[a-f0-9]{64}$/);
        assert.notEqual(c.originalSha256, c.mutantSha256);
        if (expected.find((e) => e.id === c.id).nativeInvocation) {
          assert.equal(c.mutatedNativeInvocationCompilerCohortReached, true);
          assert.equal(c.nativeTestBodiesReachedUnderMutatedInvocation, true);
          assert.equal(c.expectedExecutedBodies, 2);
        }
      }
      return r;
    });
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    profile: "cpp-extensions",
    phase,
    ...result,
    timings,
    durationMs: Math.round(performance.now() - started),
    resourceBounds: {
      maximumConcurrentContainers: 1,
      aggregateCpuQuota: 2,
      aggregateMemoryGiB: 3,
      stageDeadlineMs: 1200000,
      engineInvocationDeadlineMs: 120000,
    },
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
