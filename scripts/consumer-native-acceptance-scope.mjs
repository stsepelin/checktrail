import assert from "node:assert/strict";
import process from "node:process";
import { consumerNativeEntrypoint } from "./consumer-native-entrypoints.mjs";
import { projectConsumerRequiredKeys } from "./consumer-witness-project.mjs";
import { selectConsumerWitnessRequirements } from "./consumer-witness-evidence.mjs";
import { selectedClangWitnessScenarios } from "./selected-clang-consumer-witness.mjs";
const oci = Object.freeze([
  "php",
  "rust",
  "ruby",
  "c",
  "cpp",
  "java",
  "kotlin",
  "scala",
  "csharp",
  "fsharp",
  "vb",
  "hcl",
  "yaml",
  "swift",
]);
const selectedSlot = "native-linux-arm64-node22";
/** Internal operator/CI entrypoints only. This data selects no product/MCP execution authority. */
export function selectConsumerNativeAcceptance(
  manifest,
  inventory,
  profiles,
  profile,
  slot,
) {
  const families = selectConsumerWitnessRequirements(
    manifest,
    inventory,
    profiles,
  );
  assert.equal(typeof profile, "string");
  assert.equal(typeof slot, "string");
  const runtimes = inventory.runtimeProfiles.filter(
    (runtime) => runtime.id === slot,
  );
  assert.equal(runtimes.length, 1, "Unknown selected consumer runtime slot");
  const runtime = runtimes[0];
  let command, selected, docker, requiredObservations;
  if (profile === "consumer-impact") {
    selected = ["javascript", "shared-json"];
    command =
      slot === selectedSlot
        ? ["scripts/verify-consumer-runtime-arm64.mjs"]
        : ["scripts/verify-consumer-runtime.mjs", slot];
    docker = slot === selectedSlot;
    requiredObservations = Object.fromEntries(
      selected.map((family) => [
        family,
        projectConsumerRequiredKeys(inventory, family).filter(
          (row) => row.slot === slot,
        ),
      ]),
    );
  } else if (profile === "javascript-extensions") {
    assert.equal(
      slot,
      selectedSlot,
      "TypeScript requires its selected native runtime",
    );
    selected = ["typescript"];
    command = ["scripts/verify-javascript-extensions-container.mjs"];
    docker = true;
    requiredObservations = {
      typescript: projectConsumerRequiredKeys(inventory, "typescript"),
    };
  } else if (profile === "selected-clang") {
    assert.equal(
      slot,
      selectedSlot,
      "Selected Clang requires its selected native runtime",
    );
    selected = [];
    command = ["scripts/verify-cpp-extensions-container.mjs", "acceptance"];
    docker = true;
    requiredObservations = {
      selectedClang: selectedClangWitnessScenarios.flatMap((scope) =>
        ["source", "installed"].map((origin) => ({
          variant: scope.variant,
          origin,
          phase: scope.phase,
          scenario: scope.scenario,
        })),
      ),
    };
  } else {
    const matching = families.filter(
      (family) =>
        family.profile === profile &&
        !["consumer-impact", "javascript-extensions"].includes(profile),
    );
    assert.equal(
      matching.length,
      1,
      "Unknown native consumer acceptance profile",
    );
    const family = matching[0];
    assert.equal(
      family.runtime,
      slot,
      "Native family requires its declared runtime",
    );
    selected = [family.id];
    docker = oci.includes(family.id);
    assert.ok(docker || ["go", "python"].includes(family.id));
    command = docker
      ? ["scripts/verify-" + family.id + "-context-container.mjs"]
      : ["scripts/verify-consumer-witness-profile.mjs", profile];
    requiredObservations = {
      [family.id]: family.cases.flatMap((variant) =>
        ["source", "installed"].map((origin) => ({
          family: family.id,
          variant: variant.id,
          origin,
          slot,
        })),
      ),
    };
  }
  assert.deepEqual(command, consumerNativeEntrypoint(profile, slot));
  for (const family of selected) {
    const row = families.find((row) => row.id === family);
    assert.ok(row);
    assert.equal(row.collectorImplementation, "prepared");
    assert.equal(row.nativeAcceptance, "pending");
  }
  return {
    schemaVersion: 1,
    profile: "native-consumer-acceptance-scope-v1",
    id: profile + ":" + slot,
    acceptanceProfile: profile,
    runtime,
    families: selected,
    selectedClang: profile === "selected-clang",
    docker,
    command: { executable: process.execPath, args: command },
    requiredObservations,
    requiresSourceAndFresh: true,
    grantsProjectExecutionTrust: false,
    hostAttestationPerformed: false,
    gateAComplete: false,
  };
}
/** Enumerate all frozen scopes; JS and JSON share real invocations, never duplicated receipts. */
export function consumerNativeAcceptanceScopes(manifest, inventory, profiles) {
  const families = selectConsumerWitnessRequirements(
      manifest,
      inventory,
      profiles,
    ),
    scopes = [];
  for (const family of families) {
    if (family.id === "shared-json") continue;
    const slots =
      family.runtime === "engine-matrix"
        ? inventory.runtimeProfiles.map((runtime) => runtime.id)
        : [family.runtime];
    for (const slot of slots)
      scopes.push(
        selectConsumerNativeAcceptance(
          manifest,
          inventory,
          profiles,
          family.profile,
          slot,
        ),
      );
  }
  scopes.push(
    selectConsumerNativeAcceptance(
      manifest,
      inventory,
      profiles,
      "selected-clang",
      selectedSlot,
    ),
  );
  assert.equal(new Set(scopes.map((scope) => scope.id)).size, scopes.length);
  assert.deepEqual(
    [...new Set(scopes.flatMap((scope) => scope.families))].sort(),
    families.map((family) => family.id).sort(),
  );
  return scopes;
}
