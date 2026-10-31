import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { captureConsumerWitnessController } from "./consumer-witness-controller.mjs";
import {
  bindConsumerWitnessController,
  inspectConsumerWitnesses,
  requireQualifiedConsumerWitnessSlot,
} from "./consumer-witness-evidence.mjs";
import {
  projectConsumerScenarios,
  projectConsumerFamilies,
} from "./consumer-witness-project.mjs";
import { observeConsumerWitnessTool } from "../dist/test/consumer-witness-fixture.js";
const data = async (root, file) =>
  JSON.parse(await readFile(path.join(root, file), "utf8"));
/** Per-family binding is a projection; the caller still reconciles the complete shared collection. */
export function projectConsumerFamilyCollection(collection, family) {
  assert.equal(collection?.profile, "native-consumer-witness-collection-v1");
  assert.ok(projectConsumerFamilies.includes(family));
  return {
    ...collection,
    family,
    observations: collection.observations.filter(
      (row) => row.family === family,
    ),
    attemptRecords: collection.attemptRecords.filter(
      (row) => row.value?.family === family,
    ),
  };
}
/** Existing trusted runtime/OCI controllers provide real observations, never a project label or tool argument. */
export async function bindProjectConsumerCollection(
  root,
  families,
  collection,
  runtimeImage,
  runtime,
  { requireSelectedSlot = false } = {},
) {
  const bindings = [];
  let selectedSlot = null;
  for (const family of families) {
    const expected = await captureConsumerWitnessController(
      root,
      family,
      runtimeImage,
      runtime,
      collection.observedTool,
    );
    bindings.push(
      ...bindConsumerWitnessController(
        projectConsumerFamilyCollection(collection, family),
        expected,
      ),
    );
    selectedSlot = expected.selectedRuntimeSlot;
  }
  const coverage = inspectConsumerWitnesses(
    await data(root, "docs/gate-a-consumer-witnesses.v1.json"),
    await data(root, "docs/gate-a-profiles.v1.json"),
    await data(root, "scripts/required-native-tests.json"),
    collection.observations,
    bindings,
    collection.attemptRecords,
  );
  assert.deepEqual(
    coverage.issues,
    [],
    "Native project reconciliation has unmatched failed or duplicate attempts",
  );
  for (const family of families) {
    const canonical = collection.observations.filter(
      (row) => row.family === family && row.phase === "canonical",
    );
    const needed = ["broken", "fixed", "near-miss"].flatMap((variant) =>
      ["source", "installed"].flatMap((origin) =>
        projectConsumerScenarios(family, variant).map((scenario) =>
          JSON.stringify([variant, origin, scenario]),
        ),
      ),
    );
    assert.deepEqual(
      canonical
        .map((row) =>
          JSON.stringify([row.variant, row.origin, row.project.scenario]),
        )
        .sort(),
      needed.sort(),
      "Every original native scenario must be observed in source and fresh installs",
    );
    if (requireSelectedSlot)
      requireQualifiedConsumerWitnessSlot(coverage, family, selectedSlot);
  }
  return {
    ...collection,
    bindings,
    coverage,
    selectedRuntimeSlot: selectedSlot,
  };
}
export async function projectConsumerCollection(
  root,
  family,
  capture,
  evidence,
  compiledEngine,
) {
  assert.ok(path.isAbsolute(root));
  const observedTool = await observeConsumerWitnessTool(family);
  return {
    schemaVersion: 1,
    profile: "native-consumer-witness-collection-v1",
    family,
    evidence,
    observations: capture.observations,
    attemptRecords: capture.attemptRecords,
    observedTool,
    compiledEngine,
    retainedCaptureBytes: capture.retainedBytes,
    controllerBindingSource: "existing-native-runtime-observer",
    nativeControllerBindingsReady: true,
    nativeHostAttestationPerformed: false,
    gateAComplete: false,
    qualityAssessed: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
}
