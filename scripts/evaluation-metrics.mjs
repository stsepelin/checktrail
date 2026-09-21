import assert from "node:assert/strict";

export function summarizeEvaluation(cases, observations) {
  assert.ok(cases.length > 0 && cases.length <= 64);
  const ids = new Set(cases.map((item) => item.id));
  assert.equal(ids.size, cases.length);
  assert.equal(observations.length, cases.length);
  assert.equal(new Set(observations.map((item) => item.id)).size, cases.length);
  assert.ok(observations.every((item) => ids.has(item.id)));
  const families = [...new Set(cases.map((item) => item.family))].sort();
  return families.map((family) => {
    const expected = cases.filter((item) => item.family === family);
    const results = expected.map((item) => ({
      expected: item,
      observed: observations.find((result) => result.id === item.id),
    }));
    const systems = {};
    for (const system of ["engine", "native"]) {
      const matrix = Object.fromEntries(
        ["defect", "valid", "insufficient-evidence", "unsupported-profile"].map(
          (label) => [label, { passed: 0, failed: 0, incomplete: 0 }],
        ),
      );
      let detected = 0;
      let wrongFailureSignal = 0;
      for (const { expected: item, observed } of results) {
        const result = observed[system];
        assert.ok(["passed", "failed", "incomplete"].includes(result.outcome));
        assert.equal(typeof result.signalMatched, "boolean");
        assert.ok(Number.isFinite(result.wallMs) && result.wallMs >= 0);
        assert.ok(Object.hasOwn(matrix, item.label));
        matrix[item.label][result.outcome]++;
        if (item.label === "defect" && result.outcome === "failed") {
          if (result.signalMatched) detected++;
          else wrongFailureSignal++;
        }
      }
      const count = (label) =>
        Object.values(matrix[label]).reduce((sum, value) => sum + value, 0);
      assert.equal(
        Object.keys(matrix).reduce((sum, label) => sum + count(label), 0),
        expected.length,
      );
      const rate = (numerator, denominator) => ({
        numerator,
        denominator,
        fraction: denominator ? numerator / denominator : null,
      });
      systems[system] = {
        matrix,
        detection: rate(detected, count("defect")),
        falsePositives: rate(matrix.valid.failed, count("valid")),
        incompleteValidCases: matrix.valid.incomplete,
        wrongFailureSignal,
        passesOnInsufficientEvidence: matrix["insufficient-evidence"].passed,
        passesOnUnsupportedProfile: matrix["unsupported-profile"].passed,
        totalWallMs: results.reduce(
          (sum, { observed }) => sum + observed[system].wallMs,
          0,
        ),
      };
    }
    return { family, cases: expected.length, systems };
  });
}
