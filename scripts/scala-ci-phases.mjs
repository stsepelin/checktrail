import assert from "node:assert/strict";

export const scalaCiPhases = Object.freeze(["source", "guards", "installed"]);

export function selectScalaCiPhases(args) {
  assert.ok(
    Array.isArray(args) && args.length <= 1,
    "Unknown Scala CI phase selection",
  );
  if (args.length === 0 || args[0] === "all") return [...scalaCiPhases];
  assert.ok(
    scalaCiPhases.includes(args[0]),
    "Unknown Scala CI phase selection",
  );
  return [...args];
}

export function runScalaCiPhases(phases, handlers, required) {
  assert.ok(Array.isArray(phases) && phases.length > 0);
  assert.deepEqual(
    phases,
    scalaCiPhases.filter((phase) => phases.includes(phase)),
  );
  assert.ok(Number.isSafeInteger(required) && required > 0);
  for (const phase of phases) assert.equal(typeof handlers[phase], "function");
  const receipts = {};
  const requireCohort = (receipt) => {
    assert.equal(receipt.complete, true);
    assert.equal(receipt.required, required);
    assert.equal(receipt.passed, required);
  };
  for (const phase of phases) {
    const receipt = handlers[phase]();
    assert.ok(
      receipt && typeof receipt === "object" && !Array.isArray(receipt),
    );
    if (phase === "source") requireCohort(receipt);
    else if (phase === "installed") {
      assert.equal(receipt.offlineProductionInstall, true);
      assert.equal(receipt.lifecycleScriptsExecuted, false);
      assert.equal(receipt.harnessOutsideInstalledPackage, true);
      requireCohort(receipt.profile);
    } else {
      assert.equal(receipt.sourceRestored, true);
      assert.equal(receipt.callbacksUnchanged, true);
      assert.ok(Array.isArray(receipt.guards) && receipt.guards.length > 0);
      for (const guard of receipt.guards) {
        assert.equal(guard.originalPassed, true);
        assert.equal(guard.mutantKilled, true);
      }
    }
    receipts[phase] = receipt;
  }
  return {
    selectedPhases: [...phases],
    selectedPhasesComplete: true,
    allPhasesComplete: scalaCiPhases.every((phase) =>
      Object.hasOwn(receipts, phase),
    ),
    receipts,
  };
}
