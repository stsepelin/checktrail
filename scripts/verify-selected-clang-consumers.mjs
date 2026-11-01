import assert from "node:assert/strict";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  captureCompiledEngine,
  requireUnchangedCompiledEngine,
} from "./compiled-engine-evidence.mjs";
import { runRequiredTests } from "./required-test-evidence.mjs";
import { collectConsumerWitnesses } from "./consumer-witness-collection.mjs";
import {
  inspectSelectedClangConsumerWitnesses,
  selectSelectedClangRequirements,
} from "./selected-clang-consumer-witness.mjs";
assert.equal(
  process.argv.length,
  2,
  "Usage: verify-selected-clang-consumers.mjs",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const requirements = await selectSelectedClangRequirements(root);
const before = await captureCompiledEngine(path.join(root, "dist/src"));
const packet = await collectConsumerWitnesses(
  () => runRequiredTests(requirements, { timeoutMs: 600000 }),
  async (evidence, capture) => {
    assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
    assert.equal(evidence.required, requirements.length);
    assert.equal(evidence.passed, requirements.length);
    const compiledEngine = requireUnchangedCompiledEngine(
      before,
      await captureCompiledEngine(path.join(root, "dist/src")),
    );
    const coverage = await inspectSelectedClangConsumerWitnesses(capture);
    assert.deepEqual(
      coverage.missing,
      [],
      "Original selected Clang source/fresh scenarios remain missing",
    );
    assert.deepEqual(coverage.unqualified, [
      "actual-selected-OCI-controller-binding-missing",
    ]);
    return {
      schemaVersion: 1,
      profile: "selected-clang-consumer-collection-v1",
      evidence,
      ...capture,
      compiledEngine,
      coverage,
      wholeRuntimeClosureVerified: false,
      hostAttestationPerformed: false,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
    };
  },
  { scope: "selected-clang-producer-consumer" },
);
process.stdout.write(JSON.stringify(packet) + "\n");
