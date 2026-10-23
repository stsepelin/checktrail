import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const moduleUrl = new URL(
  "../../scripts/review-runtime-evidence.mjs",
  import.meta.url,
);
type Scope = {
  runtimeProfiles: Array<{
    id: string;
    platform: string;
    architecture: string;
    node: string;
  }>;
  extensionProfiles: Array<{
    id: string;
    runtime: string;
    acceptanceFile: string;
    acceptanceCases: Array<{ id: string; name: string }>;
  }>;
};
async function data() {
  return {
    scope: JSON.parse(
      await readFile(
        new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
        "utf8",
      ),
    ) as Scope,
    profiles: JSON.parse(
      await readFile(
        new URL("../../scripts/required-native-tests.json", import.meta.url),
        "utf8",
      ),
    ),
  };
}
test("review workflow runtime binds every frozen case without admitting omitted extra foreign or adjacent controls", async () => {
  const { selectReviewRuntimeRequirements: select } = await import(
    moduleUrl.href
  );
  const { scope, profiles } = await data();
  const original = structuredClone(profiles);
  const rows = select(profiles, scope);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows, profiles["multi-candidate-workflow"]);
  rows[0].name = "OriginalReturnedCopyMutation";
  assert.deepEqual(profiles, original);
  for (const mode of ["missing", "extra", "foreign", "renamed", "duplicate"]) {
    const changed = structuredClone(profiles);
    const p = changed["multi-candidate-workflow"];
    if (mode === "missing") p.pop();
    else if (mode === "extra")
      p.push({ file: p[0].file, name: "OriginalUnplannedCase" });
    else if (mode === "foreign") p[0].file = "dist/test/foreign.test.js";
    else if (mode === "renamed") p[0].name += "-extra";
    else p[0] = p[1];
    assert.throws(() => select(changed, scope));
  }
  const adjacent = structuredClone(profiles);
  adjacent["multi-candidate-workflow-extra"] =
    adjacent["multi-candidate-workflow"];
  assert.deepEqual(
    select(adjacent, scope),
    original["multi-candidate-workflow"],
  );
  const wrongScope = structuredClone(scope);
  wrongScope.extensionProfiles.find(
    (p) => p.id === "multi-candidate-workflow",
  )!.acceptanceCases[0]!.id = "wrong";
  assert.throws(() => select(profiles, wrongScope));
});
test("review workflow runtime refuses wrong Node architecture OS image and unselected local qualification", async () => {
  const { checkReviewRuntimeSelection: check } = await import(moduleUrl.href);
  const { scope } = await data();
  const observed = (id: string) => {
    const p = scope.runtimeProfiles.find((p) => p.id === id)!;
    return {
      platform: p.platform,
      architecture: p.architecture,
      node: p.node,
      osRelease: p.platform === "darwin" ? "25.6.0" : "10.0.26100",
      osVersion:
        p.platform === "win32" ? "Windows Server 2025 Datacenter" : "observed",
      imageOS:
        p.platform === "linux"
          ? "ubuntu24"
          : p.platform === "darwin"
            ? "macos26"
            : "win25-vs2026",
      imageVersion: "20261013.0424.1",
      distributionId: "ubuntu",
      distributionVersion: "24.04",
      containerImageId: "sha256:" + "a".repeat(64),
    };
  };
  for (const p of scope.runtimeProfiles) {
    const value = observed(p.id);
    assert.equal(
      check(scope, p.id, value, p.id.startsWith("native-") ? false : true).id,
      p.id,
    );
    for (const key of ["node", "architecture", "platform"]) {
      assert.throws(() => check(scope, p.id, { ...value, [key]: "wrong" }));
    }
  }
  const mac = observed("ci-macos-node26");
  assert.throws(
    () =>
      check(scope, "ci-macos-node26", { ...mac, osRelease: "26.0.0" }, true),
    /macOS 26 kernel/,
  );
  assert.throws(
    () => check(scope, "ci-macos-node26", { ...mac, imageOS: "macos27" }, true),
    /image family/,
  );
  const linux = observed("ci-linux-node22");
  for (const change of [
    { distributionId: "debian" },
    { distributionVersion: "26.04" },
    { imageOS: "ubuntu24-extra" },
    { imageVersion: "latest" },
  ])
    assert.throws(() =>
      check(scope, "ci-linux-node22", { ...linux, ...change }, true),
    );
  assert.throws(() =>
    check(scope, "ci-linux-node22", { ...linux, imageVersion: null }, false),
  );
  assert.throws(() =>
    check(scope, "ci-linux-node22", { ...linux, imageOS: null }, false),
  );
  const win = observed("windows-node22");
  for (const change of [
    { osVersion: "Windows 11 Enterprise" },
    { osRelease: "10.0.26200" },
    { imageOS: "win25-vs2026-extra" },
  ])
    assert.throws(() =>
      check(scope, "windows-node22", { ...win, ...change }, true),
    );
  const arm = observed("native-linux-arm64-node22");
  assert.throws(() =>
    check(scope, "native-linux-arm64-node22", {
      ...arm,
      containerImageId: null,
    }),
  );
  assert.equal(check(scope, null, mac, false), null);
  assert.throws(() => check(scope, null, mac, true));
  assert.throws(() => check(scope, "UnknownOriginalSlot", mac));
});
test("review workflow runtime CLI refuses unknown slots before running workflow callbacks", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/verify-review-runtime.mjs", import.meta.url),
      ),
      "OriginalUnknownSlot",
    ],
    { env, encoding: "utf8", timeout: 15000, maxBuffer: 16384 },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown selected runtime slot/);
  assert.equal(r.stdout, "");
});

test("review workflow runtime rejects coherently shaped foreign installation evidence and incomplete execution", async () => {
  const { requireReviewRuntimeInstallation: check } = await import(
    moduleUrl.href
  );
  const engine = { treeSha256: "a".repeat(64), manifestSha256: "b".repeat(64) };
  const runtime = {
    slot: "ci-linux-node22",
    node: "22.23.3",
    platform: "linux",
    architecture: "x64",
    imageOS: "ubuntu24",
    imageVersion: "20261013.0424.1",
  };
  const expected = {
    engine,
    runtime,
    harnessSha256: "c".repeat(64),
    requirementsSha256: "d".repeat(64),
    packageSha256: "e".repeat(64),
  };
  const receipt = {
    offlineProductionInstall: true,
    lifecycleScriptsExecuted: false,
    harnessOutsideInstalledPackage: true,
    profile: {
      complete: true,
      required: 9,
      passed: 9,
      compiledEngine: { ...engine, beforeAfterByteIdentitiesMatch: true },
      runtime,
      runtimeArtifactsSha256: engine.treeSha256,
      harnessSha256: expected.harnessSha256,
      requirementsSha256: expected.requirementsSha256,
      packageSha256: expected.packageSha256,
    },
  };
  assert.deepEqual(check(receipt, expected), receipt);
  const mutations: Array<(r: typeof receipt) => void> = [
    (r) => {
      r.offlineProductionInstall = false;
    },
    (r) => {
      r.lifecycleScriptsExecuted = true;
    },
    (r) => {
      r.harnessOutsideInstalledPackage = false;
    },
    (r) => {
      r.profile.complete = false;
    },
    (r) => {
      r.profile.required = 8;
    },
    (r) => {
      r.profile.passed = 8;
    },
    (r) => {
      r.profile.compiledEngine.beforeAfterByteIdentitiesMatch = false;
    },
    (r) => {
      r.profile.compiledEngine.treeSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.compiledEngine.manifestSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.runtime = { ...runtime, node: "24.21.0" };
    },
    (r) => {
      r.profile.runtime = { ...runtime, imageVersion: "20261014.0424.1" };
    },
    (r) => {
      r.profile.harnessSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.requirementsSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.packageSha256 = "f".repeat(64);
    },
    (r) => {
      r.profile.runtimeArtifactsSha256 = "f".repeat(64);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => check(changed, expected));
  }
  const local = { ...expected, runtime: { ...runtime, slot: null } };
  assert.deepEqual(check(receipt, local), receipt);
  const foreign = structuredClone(receipt);
  foreign.profile.compiledEngine.treeSha256 = "f".repeat(64);
  assert.throws(() => check(foreign, local));
});
