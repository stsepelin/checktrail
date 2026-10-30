import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { attemptFoundationFiles } from "./attempt-foundation-evidence.mjs";
export const attemptWholeHarnessFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "docs/gate-a-profiles.v1.json",
  "scripts/required-native-tests.json",
  "scripts/required-test-evidence.mjs",
  "scripts/compiled-engine-evidence.mjs",
  "scripts/attempt-whole-evidence.mjs",
  "scripts/attempt-foundation-evidence.mjs",
  ...attemptFoundationFiles,
  "scripts/attempt-runtime-evidence.mjs",
  "scripts/attempt-runtime-tools.Dockerfile",
  "scripts/verify-attempt-runtime.mjs",
  "scripts/verify-attempt-runtime-arm64.mjs",
  "scripts/pull-pinned-image.mjs",
  "scripts/prepare-acceptance-cache-subset.mjs",
  "scripts/verify-attempt-archives-whole-package.mjs",
  "scripts/install-acceptance-package.mjs",
  "dist/test/gate-attempt-archives.test.js",
  "dist/test/attempt-whole-fixture.js",
  "dist/test/attempt-whole-controls.js",
  "dist/test/attempt-whole-boundaries.js",
  "dist/test/tasks-wire-fixture.js",
  "dist/test/helpers.js",
  "dist/test/native-storage-fixture.js",
  "dist/test/tool-fixture.js",
]);
export const attemptHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function selectAttemptWholeRequirements(profiles, scope) {
  const selected = scope.extensionProfiles.filter(
    (p) => p.id === "attempt-archives",
  );
  assert.equal(selected.length, 1);
  const p = selected[0];
  assert.equal(p.runtime, "engine-matrix");
  assert.equal(p.acceptanceFile, "dist/test/gate-attempt-archives.test.js");
  const kinds = [
    "broken",
    "fixed",
    "near-miss",
    "prerequisite",
    "stale",
    "empty",
    "privacy",
    "lifecycle",
    "installed",
  ];
  assert.deepEqual(
    p.acceptanceCases.map((c) => [c.id, c.name]),
    kinds.map((k) => [k, "attempt-archives " + k + " acceptance"]),
  );
  const requirements = p.acceptanceCases.map((c) => ({
    file: p.acceptanceFile,
    name: c.name,
  }));
  assert.deepEqual(
    profiles["attempt-archives"],
    requirements,
    "Frozen attempt archive callbacks changed",
  );
  return requirements;
}
export async function captureAttemptHarness(root) {
  const inputs = await Promise.all(
    attemptWholeHarnessFiles.map(async (file) => ({
      file,
      bytes: await readFile(path.join(root, file)),
    })),
  );
  return {
    inputs,
    sha256: attemptHash(
      JSON.stringify(inputs.map((x) => [x.file, attemptHash(x.bytes)])),
    ),
  };
}
export function requireAttemptTerminalCases(p, requirements, acceptanceSha256) {
  assert.match(acceptanceSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(p.complete, true, JSON.stringify(p.problems));
  assert.equal(p.required, 9);
  assert.equal(p.passed, 9);
  assert.equal(p.ledger.truncated, false);
  assert.equal(p.ledger.cases.length, 9);
  assert.equal(p.ledger.schemaVersion, 1);
  assert.equal(p.ledger.files.length, 1);
  const file = p.ledger.files[0];
  assert.equal(typeof file.id, "string");
  assert.ok(file.id.length > 0);
  assert.equal(file.stable, true);
  assert.deepEqual(file.before, { state: "present", sha256: acceptanceSha256 });
  assert.deepEqual(file.after, file.before);
  assert.equal(p.ledger.terminalEventCount, 9);
  assert.equal(p.ledger.events.length, 9);
  const events = new Map();
  for (const event of p.ledger.events) {
    assert.equal(event.fileId, file.id);
    assert.equal(event.kind, "test");
    assert.equal(event.outcome, "passed");
    assert.equal(event.nameTruncated, false);
    assert.equal(event.required, true);
    assert.equal(Number.isSafeInteger(event.sequence), true);
    assert.ok(event.sequence >= 1 && event.sequence <= 9);
    assert.equal(events.has(event.name), false);
    assert.equal(Number.isFinite(event.durationMs), true);
    assert.ok(event.durationMs >= 0);
    events.set(event.name, event);
  }
  assert.equal(new Set([...events.values()].map((e) => e.sequence)).size, 9);
  for (const item of p.ledger.cases) {
    assert.equal(item.fileId, file.id);
    assert.ok(events.has(item.name));
    assert.deepEqual(item.terminalSequences, [events.get(item.name).sequence]);
  }

  assert.deepEqual(
    p.ledger.cases.map((c) => [c.name, c.outcome]).sort(),
    requirements.map((c) => [c.name, "passed"]).sort(),
  );
}
