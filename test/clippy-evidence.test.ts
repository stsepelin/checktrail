import assert from "node:assert/strict";
import { test } from "node:test";
import { rustEvidence } from "../src/rust-evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
const check: Check = {
  id: "rust.cargo-clippy",
  adapter: "rust",
  project: ".",
  scope: ["src/lib.rs"],
  kind: "analysis",
  parser: "rust-json",
  reason: "synthetic",
  commands: [],
};
const target = {
  name: "synthetic_clippy",
  src_path: "/synthetic/src/lib.rs",
  kind: ["lib"],
  test: true,
};
function packet() {
  return {
    version: 2,
    mode: "clippy",
    clippyVersion: "0.1.98",
    forcedLintGroup: "clippy::all",
    cargoVersion: "1.98.1",
    rustcVersion: "1.98.1",
    project: ".",
    packageId: "synthetic-id",
    exitCode: 0,
    targets: [target],
    events: [
      {
        reason: "compiler-artifact",
        package_id: "synthetic-id",
        target,
        fresh: false,
        profile: { test: true },
      },
      { reason: "build-finished", success: true },
    ],
    observedSources: ["src/lib.rs"],
    depInfoCount: 1,
    scopeError: false,
  };
}
function process(value: unknown): ProcessResult {
  return {
    command: { executable: "node", args: [], cwd: "." },
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
  };
}
function diagnostic(code = "clippy::eq_op", file = "src/lib.rs") {
  return {
    reason: "compiler-message",
    package_id: "synthetic-id",
    message: {
      level: "warning",
      code: { code },
      message: "equal expressions",
      spans: [{ file_name: file, line_start: 1, is_primary: true }],
    },
  };
}
test("Clippy evidence requires pinned activation exact source fresh artifacts and native completion", () => {
  const original = packet();
  assert.equal(
    rustEvidence(check, [process(original)], "/synthetic").status,
    "passed",
  );
  for (const patch of [
    { version: 1 },
    { mode: "check" },
    { clippyVersion: "0.1.99" },
    { forcedLintGroup: "clippy::pedantic" },
    { forcedLintGroup: "clippy::all_other" },
    { cargoVersion: "1.98.0" },
    { targets: [] },
    { events: [] },
    { observedSources: [] },
    { observedSources: ["src/lib.rs", "src/lib.rs"] },
    { observedSources: ["../foreign.rs"] },
    { depInfoCount: 0 },
    { scopeError: true },
    { events: [{ ...original.events[0], fresh: true }, original.events[1]] },
    {
      events: [
        original.events[0],
        { reason: "build-finished", success: false },
      ],
    },
  ]) {
    const result = rustEvidence(
      check,
      [process({ ...original, ...patch })],
      "/synthetic",
    );
    assert.equal(result.status, "inconclusive", JSON.stringify(patch));
    assert.notEqual(result.findingsComplete, true);
  }
  assert.equal(
    rustEvidence(check, [process(original), process(original)], "/synthetic")
      .status,
    "inconclusive",
  );
  assert.equal(
    rustEvidence(check, [process(original)], undefined).status,
    "inconclusive",
  );
});
test("Clippy findings fail on warnings deduplicate identical native targets and retain unknown addresses without complete claims", () => {
  const original = packet();
  const lint = diagnostic();
  let result = rustEvidence(
    check,
    [process({ ...original, events: [lint, lint, ...original.events] })],
    "/synthetic",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.findingsComplete, true);
  assert.deepEqual(result.findings, [
    {
      ruleId: "clippy/eq_op",
      level: "warning",
      message: "equal expressions",
      file: "src/lib.rs",
      line: 1,
    },
  ]);
  for (const file of ["../foreign.rs", "unlinked.rs"]) {
    result = rustEvidence(
      check,
      [
        process({
          ...original,
          events: [diagnostic("clippy::eq_op", file), ...original.events],
        }),
      ],
      "/synthetic",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.findingsComplete, false);
    assert.equal(result.findings?.[0]?.file, undefined);
  }
  result = rustEvidence(
    check,
    [
      process({
        ...original,
        events: [diagnostic("clippy_other::eq_op"), ...original.events],
      }),
    ],
    "/synthetic",
  );
  assert.equal(result.status, "passed");
  assert.equal(result.findings?.[0]?.ruleId, "rustc/clippy_other::eq_op");
  const noAddress = {
    ...lint,
    message: { ...lint.message, code: { code: "unused" }, spans: [] },
  };
  result = rustEvidence(
    check,
    [process({ ...original, events: [noAddress, ...original.events] })],
    "/synthetic",
  );
  assert.equal(result.status, "inconclusive");
  assert.equal(result.findingsComplete, false);
  result = rustEvidence(
    check,
    [
      process({
        ...original,
        events: [
          {
            ...lint,
            message: {
              ...lint.message,
              level: "error",
              code: { code: "E0308" },
            },
          },
        ],
        exitCode: 101,
      }),
    ],
    "/synthetic",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.findingsComplete, false);
  result = rustEvidence(
    check,
    [process({ ...original, exitCode: 101 })],
    "/synthetic",
  );
  assert.equal(result.status, "error");
  assert.equal(result.findingsComplete, false);
});

test("Clippy configuration classification requires the pinned native message and exact local configuration address", () => {
  const original = packet();
  const lint = diagnostic();
  const error = {
    ...lint,
    message: {
      ...lint.message,
      level: "error",
      code: null,
      message: "error reading Clippy's configuration file: invalid type",
      spans: [{ file_name: "clippy.toml", line_start: 1, is_primary: true }],
    },
  };
  for (const name of ["clippy.toml", ".clippy.toml"]) {
    const result = rustEvidence(
      check,
      [
        process({
          ...original,
          events: [
            {
              ...error,
              message: {
                ...error.message,
                spans: [{ file_name: name, line_start: 1, is_primary: true }],
              },
            },
          ],
          exitCode: 101,
        }),
      ],
      "/synthetic",
    );
    assert.equal(result.status, "error");
    assert.equal(result.findingsComplete, false);
  }
  for (const file of [
    "../clippy.toml",
    "src/clippy.toml",
    "clippy.toml.other",
  ]) {
    const result = rustEvidence(
      check,
      [
        process({
          ...original,
          events: [
            {
              ...error,
              message: {
                ...error.message,
                spans: [{ file_name: file, line_start: 1, is_primary: true }],
              },
            },
          ],
          exitCode: 101,
        }),
      ],
      "/synthetic",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.findingsComplete, false);
  }
});
