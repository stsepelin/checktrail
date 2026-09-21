import assert from "node:assert/strict";
import path from "node:path";

function diagnostic(value) {
  assert.ok(value && typeof value === "object");
  assert.match(value.code, /^(?:[A-Z]+[0-9]+|syntax-error)$/);
  assert.match(value.file, /^[A-Za-z0-9_-]+\.py$/);
  for (const key of ["line", "column"])
    assert.ok(Number.isSafeInteger(value[key]) && value[key] > 0);
  return {
    code: value.code,
    file: value.file,
    line: value.line,
    column: value.column,
  };
}
export function extractRuffSnapshot(text, rule, file) {
  assert.ok(typeof text === "string" && text.length <= 524288);
  assert.match(rule, /^F[0-9]{3}$/);
  assert.match(file, /^F[0-9]{3}_0\.py$/);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  assert.deepEqual(lines.slice(0, 3), [
    "---",
    "source: crates/ruff_linter/src/rules/pyflakes/mod.rs",
    "---",
  ]);
  const result = [];
  let arrows = 0;
  for (let i = 3; i < lines.length; i++) {
    if (/^\s*-->/.test(lines[i])) arrows++;
    const header = /^([A-Z]+[0-9]+) (?:\[\*\] )?\S/.exec(lines[i]);
    if (!header) continue;
    assert.equal(header[1], rule, "Snapshot contains a different rule");
    const location = /^\s*--> ([A-Za-z0-9_-]+\.py):([0-9]+):([0-9]+)$/.exec(
      lines[i + 1] ?? "",
    );
    assert.ok(location, "Diagnostic has no immediate primary location");
    assert.equal(location[1], file);
    result.push(
      diagnostic({
        code: rule,
        file,
        line: Number(location[2]),
        column: Number(location[3]),
      }),
    );
  }
  assert.equal(arrows, result.length, "Unaccounted diagnostic location");
  assert.ok(
    result.length > 0 || lines.slice(3).join("").trim() === "",
    "Unrecognized nonempty snapshot",
  );
  return result;
}
export function normalizeRuffDiagnostics(value, root, file) {
  assert.ok(Array.isArray(value) && value.length <= 10000);
  return value.map((item) => {
    assert.equal(item.filename, path.join(root, file));
    return diagnostic({
      code: item.code ?? "syntax-error",
      file,
      line: item.location?.row,
      column: item.location?.column,
    });
  });
}
export function compareRuffDiagnostics(expected, observed) {
  assert.ok(Array.isArray(expected) && Array.isArray(observed));
  const pending = expected.map(diagnostic);
  const unexpected = [];
  let matched = 0;
  for (const item of observed.map(diagnostic)) {
    const index = pending.findIndex(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(item),
    );
    if (index < 0) unexpected.push(item);
    else {
      pending.splice(index, 1);
      matched++;
    }
  }
  return {
    expected: expected.length,
    observed: observed.length,
    matched,
    missing: pending,
    unexpected,
  };
}

export function summarizeRuffEvaluation(cases, observations) {
  assert.ok(
    Array.isArray(cases) && cases.length > 0 && Array.isArray(observations),
  );
  assert.equal(new Set(cases.map((item) => item.rule)).size, cases.length);
  const rows = [];
  let consumed = 0;
  for (const item of cases) {
    assert.match(item.rule, /^F[0-9]{3}$/);
    assert.equal(item.file, `${item.rule}_0.py`);
    if (item.expected !== null)
      for (const value of item.expected) {
        assert.equal(value.code, item.rule);
        assert.equal(value.file, item.file);
      }
    for (const system of ["native", "verifier"]) {
      const matches = observations.filter(
        (value) => value.rule === item.rule && value.system === system,
      );
      if (item.expected === null) {
        assert.equal(matches.length, 0);
        assert.equal(item.exclusion, "unsupported-snapshot");
        rows.push({
          rule: item.rule,
          system,
          classification: "excluded",
          comparison: null,
        });
        continue;
      }
      assert.equal(
        matches.length,
        1,
        "Every measured file requires one observation per system",
      );
      consumed++;
      const observation = matches[0];
      assert.equal(typeof observation.complete, "boolean");
      assert.ok(
        ["passed", "failed", "incomplete"].includes(observation.outcome),
      );
      const comparison = compareRuffDiagnostics(
        item.expected,
        observation.diagnostics,
      );
      if (observation.complete)
        assert.equal(
          observation.outcome,
          observation.diagnostics.length ? "failed" : "passed",
          "Complete outcome disagrees with diagnostics",
        );
      rows.push({
        rule: item.rule,
        system,
        classification: !observation.complete
          ? "incomplete"
          : comparison.missing.length || comparison.unexpected.length
            ? "different"
            : "matched",
        comparison,
      });
    }
  }
  assert.equal(
    consumed,
    observations.length,
    "Unknown or duplicate observation",
  );
  return {
    rows,
    counts: {
      files: cases.length,
      excludedFiles: cases.filter((item) => item.expected === null).length,
      systemFileResults: rows.length,
      matched: rows.filter((item) => item.classification === "matched").length,
      different: rows.filter((item) => item.classification === "different")
        .length,
      incomplete: rows.filter((item) => item.classification === "incomplete")
        .length,
      excluded: rows.filter((item) => item.classification === "excluded")
        .length,
    },
  };
}
