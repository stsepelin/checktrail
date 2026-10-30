import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { test } from "node:test";
const { selectConsumerNativeAcceptance, consumerNativeAcceptanceScopes } =
  await import(
    new URL(
      "../../scripts/consumer-native-acceptance-scope.mjs",
      import.meta.url,
    ).href
  );
const load = async (name: string) =>
  JSON.parse(await readFile(new URL("../../" + name, import.meta.url), "utf8"));
const manifest = await load("docs/gate-a-consumer-witnesses.v1.json"),
  inventory = await load("docs/gate-a-profiles.v1.json"),
  profiles = await load("scripts/required-native-tests.json");
test("native acceptance scope enumeration covers every required family every engine slot and the separate selected Clang graph without running commands", async () => {
  const scopes = consumerNativeAcceptanceScopes(manifest, inventory, profiles);
  assert.deepEqual(
    [
      ...new Set(
        scopes.flatMap((scope: { families: string[] }) => scope.families),
      ),
    ].sort(),
    manifest.families.map((family: { id: string }) => family.id).sort(),
  );
  for (const slot of inventory.runtimeProfiles) {
    const found = scopes.filter(
      (scope: { acceptanceProfile: string; runtime: { id: string } }) =>
        scope.acceptanceProfile === "consumer-impact" &&
        scope.runtime.id === slot.id,
    );
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].families, ["javascript", "shared-json"]);
    assert.equal(found[0].requiredObservations.javascript.length, 6);
    assert.equal(found[0].requiredObservations["shared-json"].length, 6);
  }
  const ts = scopes.filter(
    (scope: { acceptanceProfile: string }) =>
      scope.acceptanceProfile === "javascript-extensions",
  );
  assert.equal(ts.length, 1);
  assert.equal(ts[0].requiredObservations.typescript.length, 14);
  const clang = scopes.filter(
    (scope: { selectedClang: boolean }) => scope.selectedClang,
  );
  assert.equal(clang.length, 1);
  assert.equal(clang[0].requiredObservations.selectedClang.length, 14);
  assert.deepEqual(clang[0].families, []);
  for (const scope of scopes) {
    assert.equal(scope.command.executable, process.execPath);
    await access(new URL("../../" + scope.command.args[0], import.meta.url));
    assert.equal(scope.grantsProjectExecutionTrust, false);
    assert.equal(scope.gateAComplete, false);
  }
});
test("native acceptance entrypoints require exact declared profile and runtime identifiers and cannot accept a command or neighboring family spelling", () => {
  for (const profile of [
    "context-go-extra",
    "context-php/../../other",
    "javascript",
    "shared-json",
    "selected-clang-extra",
    "node -e original",
  ])
    assert.throws(() =>
      selectConsumerNativeAcceptance(
        manifest,
        inventory,
        profiles,
        profile,
        "native-linux-arm64-node22",
      ),
    );
  assert.throws(() =>
    selectConsumerNativeAcceptance(
      manifest,
      inventory,
      profiles,
      "consumer-impact",
      "native-linux-arm64-node22-extra",
    ),
  );
  const other = inventory.runtimeProfiles.find(
    (runtime: { id: string }) => runtime.id !== "native-linux-arm64-node22",
  );
  for (const profile of [
    "context-go",
    "context-python",
    "context-cpp",
    "javascript-extensions",
    "selected-clang",
  ])
    assert.throws(() =>
      selectConsumerNativeAcceptance(
        manifest,
        inventory,
        profiles,
        profile,
        other.id,
      ),
    );
  const hosted = selectConsumerNativeAcceptance(
    manifest,
    inventory,
    profiles,
    "context-go",
    "native-linux-arm64-node22",
  );
  assert.equal(hosted.docker, false);
  assert.deepEqual(hosted.command.args, [
    "scripts/verify-consumer-witness-profile.mjs",
    "context-go",
  ]);
  const arm = selectConsumerNativeAcceptance(
    manifest,
    inventory,
    profiles,
    "consumer-impact",
    "native-linux-arm64-node22",
  );
  assert.equal(arm.docker, true);
  assert.deepEqual(arm.command.args, [
    "scripts/verify-consumer-runtime-arm64.mjs",
  ]);
});
