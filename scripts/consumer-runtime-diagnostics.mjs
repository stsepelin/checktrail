// Diagnostic metadata only: no project execution or native acceptance permission.
import assert from "node:assert/strict";
const file = "dist/test/gate-consumer-impact.test.js";
const names = Object.freeze(
  [
    "broken",
    "fixed",
    "near-miss",
    "prerequisite",
    "stale",
    "empty",
    "privacy",
    "lifecycle",
    "installed",
  ].map((kind) => `consumer-impact ${kind} acceptance`),
);
const codes = new Set([
  "ERR_ASSERTION",
  "ERR_TEST_FAILURE",
  "ERR_TEST_TIMEOUT",
  "ERR_TEST_CANCELLED",
  "ABORT_ERR",
  "ENOENT",
  "ETIMEDOUT",
]);
const failures = new Set([
  "testCodeFailure",
  "testTimeoutFailure",
  "cancelledByParent",
  "subtestsFailed",
  "hookFailed",
  "testAborted",
]);
const outcomes = new Set(["passed", "failed", "skipped", "todo"]);
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, expected) =>
  assert.deepEqual(Object.keys(value).sort(), expected.toSorted());
const empty = (state) => ({
  schemaVersion: 1,
  profile: "native-consumer-terminal-diagnostic-v1",
  state,
  file,
  sourceFileSha256: null,
  cases: [],
  missingCases: [...names],
  qualifiesNativeAcceptance: false,
});
/** Read an already projected diagnostic without admitting arbitrary strings or fields. */
export function readConsumerTerminalDiagnostic(value) {
  if (value === undefined || value === null) return empty("missing");
  try {
    keys(value, [
      "schemaVersion",
      "profile",
      "state",
      "file",
      "sourceFileSha256",
      "cases",
      "missingCases",
      "qualifiesNativeAcceptance",
    ]);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.profile, "native-consumer-terminal-diagnostic-v1");
    assert.equal(value.file, file);
    assert.equal(value.qualifiesNativeAcceptance, false);
    assert.ok(["observed", "missing", "refused"].includes(value.state));
    assert.ok(Array.isArray(value.cases) && value.cases.length <= names.length);
    assert.ok(
      Array.isArray(value.missingCases) &&
        value.missingCases.length <= names.length,
    );
    const seen = new Set(),
      cases = [];
    for (const row of value.cases) {
      keys(row, ["name", "outcome", "durationMs", "code", "failureType"]);
      assert.ok(names.includes(row.name) && !seen.has(row.name));
      seen.add(row.name);
      assert.ok(outcomes.has(row.outcome));
      assert.ok(
        typeof row.durationMs === "number" &&
          Number.isFinite(row.durationMs) &&
          row.durationMs >= 0 &&
          row.durationMs <= 1200000,
      );
      assert.ok(row.code === null || codes.has(row.code));
      assert.ok(
        row.failureType === null ||
          row.failureType === "unknown" ||
          failures.has(row.failureType),
      );
      if (row.outcome === "passed") {
        assert.equal(row.code, null);
        assert.equal(row.failureType, null);
      }
      cases.push({
        name: row.name,
        outcome: row.outcome,
        durationMs: row.durationMs,
        code: row.code,
        failureType: row.failureType,
      });
    }
    assert.deepEqual(
      cases.map((row) => row.name),
      names.filter((name) => seen.has(name)),
    );
    const missingCases = names.filter((name) => !seen.has(name));
    assert.deepEqual(value.missingCases, missingCases);
    if (value.state === "observed") {
      assert.ok(digest(value.sourceFileSha256) && cases.length > 0);
    } else {
      assert.equal(value.sourceFileSha256, null);
      assert.equal(cases.length, 0);
    }
    return {
      ...empty(value.state),
      sourceFileSha256: value.sourceFileSha256,
      cases,
      missingCases,
    };
  } catch {
    return empty("refused");
  }
}
/** Only the exact frozen public callback family and its bound source hash may leave private storage. */
export function projectConsumerTerminalDiagnostic(
  profile,
  requirements,
  acceptanceSha256,
) {
  if (profile === undefined || profile === null) return empty("missing");
  try {
    assert.ok(
      Array.isArray(requirements) && requirements.length === names.length,
    );
    assert.deepEqual(
      requirements,
      names.map((name) => ({ file, name })),
    );
    assert.ok(digest(acceptanceSha256));
    const ledger = profile.ledger;
    assert.equal(ledger.schemaVersion, 1);
    assert.equal(ledger.truncated, false);
    assert.ok(Array.isArray(ledger.files) && ledger.files.length === 1);
    const input = ledger.files[0];
    assert.equal(input.stable, true);
    assert.equal(input.before.state, "present");
    assert.equal(input.after.state, "present");
    assert.equal(input.before.sha256, acceptanceSha256);
    assert.equal(input.after.sha256, acceptanceSha256);
    assert.ok(
      typeof input.id === "string" &&
        input.id.length > 0 &&
        input.id.length <= 64,
    );
    assert.ok(
      Array.isArray(ledger.events) && ledger.events.length <= names.length,
    );
    assert.equal(ledger.terminalEventCount, ledger.events.length);
    assert.ok(
      Array.isArray(profile.problems) &&
        profile.problems.length <= names.length * 2,
    );
    const problems = new Map(),
      accounting = new Set();
    for (const problem of profile.problems) {
      assert.ok(names.includes(problem.name));
      if (problem.reason === "required-test-not-passed") {
        keys(problem, ["name", "reason"]);
        assert.equal(accounting.has(problem.name), false);
        accounting.add(problem.name);
      } else {
        assert.ok(["failed", "skipped-or-todo"].includes(problem.reason));
        assert.equal(problems.has(problem.name), false);
        problems.set(problem.name, problem);
      }
    }
    const events = new Map(),
      sequences = new Set();
    for (const event of ledger.events) {
      assert.ok(names.includes(event.name) && !events.has(event.name));
      assert.equal(event.fileId, input.id);
      assert.equal(event.nameTruncated, false);
      assert.equal(event.kind, "test");
      assert.equal(event.required, true);
      assert.ok(
        Number.isSafeInteger(event.sequence) &&
          event.sequence > 0 &&
          !sequences.has(event.sequence),
      );
      sequences.add(event.sequence);
      assert.ok(outcomes.has(event.outcome));
      const problem = problems.get(event.name);
      if (event.outcome === "passed") {
        assert.equal(problem, undefined);
        assert.equal(accounting.has(event.name), false);
      } else if (problem) {
        assert.equal(
          problem.reason,
          event.outcome === "failed" ? "failed" : "skipped-or-todo",
        );
      }
      events.set(event.name, {
        name: event.name,
        outcome: event.outcome,
        durationMs: event.durationMs,
        code: codes.has(problem?.code) ? problem.code : null,
        failureType: problem
          ? failures.has(problem.failureType)
            ? problem.failureType
            : "unknown"
          : event.outcome === "passed"
            ? null
            : "unknown",
      });
    }
    for (const name of problems.keys()) assert.ok(events.has(name));
    if (events.size === 0) return empty("missing");
    return readConsumerTerminalDiagnostic({
      ...empty("observed"),
      sourceFileSha256: acceptanceSha256,
      cases: names
        .filter((name) => events.has(name))
        .map((name) => events.get(name)),
      missingCases: names.filter((name) => !events.has(name)),
    });
  } catch {
    return empty("refused");
  }
}
