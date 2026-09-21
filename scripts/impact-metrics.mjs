import assert from "node:assert/strict";

const fraction = (numerator, denominator) => ({
  numerator,
  denominator,
  fraction: denominator ? numerator / denominator : null,
});
export function summarizeImpact(cases, observations, repetitions) {
  assert.ok(Number.isInteger(repetitions) && repetitions >= 1);
  assert.ok(
    cases.length > 0 &&
      new Set(cases.map((item) => item.id)).size === cases.length,
  );
  assert.ok(
    cases.every((item) =>
      [
        "declared-complete",
        "declared-incomplete",
        "misdeclared-complete",
      ].includes(item.graph),
    ),
  );
  assert.equal(observations.length, cases.length * repetitions);
  const seen = new Set();
  const groups = new Map();
  for (const row of observations) {
    const specification = cases.find((item) => item.id === row.id);
    assert.ok(specification);
    assert.ok(
      Number.isInteger(row.repetition) &&
        row.repetition >= 0 &&
        row.repetition < repetitions,
    );
    const key = `${row.id}:${row.repetition}`;
    assert.ok(!seen.has(key));
    seen.add(key);
    const group = groups.get(specification.graph) ?? {
      graph: specification.graph,
      observations: 0,
      fullChecks: 0,
      selectedChecks: 0,
      fullFailures: 0,
      retainedFailures: 0,
      missedFailures: 0,
      changedFailureResults: 0,
      unexpectedFailures: 0,
      inconclusiveChecks: 0,
      selectedPassesWithFullFailures: 0,
      fullWallMs: 0,
      selectedWallMs: 0,
      fallbacks: 0,
    };
    for (const run of [row.full, row.selected]) {
      assert.ok(["passed", "failed", "incomplete"].includes(run.outcome));
      assert.ok(
        run.checks.length > 0 &&
          new Set(run.checks.map((check) => check.project)).size ===
            run.checks.length,
      );
      assert.ok(
        run.checks.every((check) =>
          [
            "passed",
            "failed",
            "unavailable",
            "skipped",
            "error",
            "inconclusive",
          ].includes(check.status),
        ),
      );
      assert.ok(Number.isFinite(run.wallMs) && run.wallMs >= 0);
      const expectedOutcome = run.checks.some(
        (check) => check.status === "failed",
      )
        ? "failed"
        : run.checks.some((check) => check.status !== "passed")
          ? "incomplete"
          : "passed";
      assert.equal(run.outcome, expectedOutcome);
    }
    const full = new Map(
      row.full.checks.map((check) => [check.project, check]),
    );
    assert.ok(row.selected.checks.every((check) => full.has(check.project)));
    const selected = new Map(
      row.selected.checks.map((check) => [check.project, check]),
    );
    const failures = row.full.checks.filter(
      (check) => check.status === "failed",
    );
    group.observations++;
    group.fullChecks += full.size;
    group.selectedChecks += selected.size;
    group.fullFailures += failures.length;
    group.retainedFailures += failures.filter(
      (check) => selected.get(check.project)?.status === "failed",
    ).length;
    group.missedFailures += failures.filter(
      (check) => !selected.has(check.project),
    ).length;
    group.changedFailureResults += failures.filter(
      (check) =>
        selected.has(check.project) &&
        selected.get(check.project).status !== "failed",
    ).length;
    group.unexpectedFailures += row.selected.checks.filter(
      (check) =>
        check.status === "failed" &&
        full.get(check.project).status !== "failed",
    ).length;
    group.inconclusiveChecks += [
      ...row.full.checks,
      ...row.selected.checks,
    ].filter((check) => !["passed", "failed"].includes(check.status)).length;
    group.selectedPassesWithFullFailures += Number(
      row.selected.outcome === "passed" && failures.length > 0,
    );
    group.fullWallMs += row.full.wallMs;
    group.selectedWallMs += row.selected.wallMs;
    group.fallbacks += Number(row.selected.selection?.mode === "full");
    groups.set(specification.graph, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    cases: cases.filter((item) => item.graph === group.graph).length,
    failureRetention: fraction(group.retainedFailures, group.fullFailures),
    omittedChecks: fraction(
      group.fullChecks - group.selectedChecks,
      group.fullChecks,
    ),
    totalWallRatio: group.fullWallMs
      ? group.selectedWallMs / group.fullWallMs
      : null,
  }));
}
