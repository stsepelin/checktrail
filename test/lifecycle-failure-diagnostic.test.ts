import assert from "node:assert/strict";
import { test } from "node:test";

test("installed lifecycle failures retain the original problem before long progress output while malformed or empty collectors retain bounded raw diagnostics", async () => {
  const { lifecycleFailureDiagnostic } = await import(
    new URL("../../scripts/lifecycle-runtime-evidence.mjs", import.meta.url)
      .href
  );
  const problem = {
    name: "original descendant cleanup witness",
    reason: "failed",
    message: "original observed cleanup mismatch",
  };
  const stderr = "progress-only\n".repeat(1000);
  const stdout = JSON.stringify({
    profile: "original-lifecycle-runtime",
    passed: 8,
    required: 9,
    complete: false,
    problems: [problem],
    ledger: "large retained ledger".repeat(1000),
  });
  assert.doesNotMatch((stdout + stderr).slice(-6000), /cleanup mismatch/);
  const structured = lifecycleFailureDiagnostic({ stdout, stderr });
  assert.deepEqual(JSON.parse(structured), {
    problems: [problem],
    profile: "original-lifecycle-runtime",
    passed: 8,
    required: 9,
    complete: false,
  });
  assert.doesNotMatch(structured, /progress-only|large retained ledger/);
  const longProblem = lifecycleFailureDiagnostic({
    stdout: JSON.stringify({
      problems: [{ ...problem, message: "x".repeat(20000) }],
    }),
    stderr,
  });
  assert.equal(longProblem.length, 6000);
  assert.match(longProblem, /original descendant cleanup witness/);
  for (const raw of [
    "",
    "{ malformed collector",
    "null",
    "[]",
    JSON.stringify({ problems: null }),
    JSON.stringify({ problems: "invalid shape" }),
    JSON.stringify({ complete: true, problems: [] }),
    JSON.stringify({ complete: false }),
  ]) {
    const rawDiagnostic =
      "early noise".repeat(1000) + "original collector crash";
    assert.equal(
      lifecycleFailureDiagnostic({ stdout: raw, stderr: rawDiagnostic }),
      (raw + rawDiagnostic).slice(-6000),
    );
  }
});
