import process from "node:process";
import assert from "node:assert/strict";
import path from "node:path";
import { runRequiredTests } from "./required-test-evidence.mjs";
const original = [
  {
    file: "dist/test/consumer-imports.test.js",
    name: "captured imports expose an undeclared consumer and full validation retains its native failure",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "a declared transitive graph retains affected consumers and omits the independent project",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "captured file edges follow reexports and unowned bridges without treating a project prefix as ownership",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "literal shared JSON reads reconcile the physical producer for named synchronous and asynchronous readers",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "unknown source and resource families retain the full shared engine plan",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "literal dynamic imports and CommonJS exact imports expose a missing graph without executing source",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "stale, excluded, empty, unsupported and exhausted import observations stay unknown",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "CommonJS module loaders retain full validation and its actual consumer assertion failure",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "compiler-dependent syntax in JavaScript retains full validation while ordinary keyword spellings remain resolved",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "workspace impact follows transitive consumers, terminates cycles and falls back for uncertain ownership",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "Git scopes committed, staged, unstaged, untracked and renamed files without running filters",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "Git selection falls back for missing history, root changes, incomplete graphs and tracked excluded content",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "worktrees have separate identities and metadata changes during validation invalidate pass",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "unresolved index stages and project-local Git executables cannot narrow or execute project code",
  },
  {
    file: "dist/test/git-selection.test.js",
    name: "CLI and MCP share startup-selected Git scope and tool calls cannot change the base",
  },
  {
    file: "dist/test/impact.test.js",
    name: "impact metrics reconcile retained, omitted, changed and incomplete failures without dropping observations",
  },
  {
    file: "dist/test/impact.test.js",
    name: "native impact measurement retains a transitive assertion failure and exposes a misdeclared graph",
  },
  {
    file: "dist/test/impact.test.js",
    name: "impact snapshots account for each paired observation, assertion identity and frozen case",
  },
];
const nested = [
  {
    file: "dist/test/consumer-imports.test.js",
    name: "dynamic-import",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "require-alias",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "shadow-require",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "computed-loader",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "reflected-loader",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "create-require",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "native-worker",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "unselected-builtin",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "mandatory-builtin-prefix",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "builtin-prefix",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "bare-package",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "package-alias",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "extensionless",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "escaping",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "encoded-path",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "query-path",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "missing-path",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "namespace-fs",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "fs-loader-require",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "reader-alias",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "shadow-reader",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "shadow-url",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "indirect-url",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "dynamic-resource",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "mutated-url",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "broken-syntax",
  },
  {
    file: "dist/test/consumer-imports.test.js",
    name: "compiler-reference",
  },
];
export const consumerFoundationHarnessFiles = Object.freeze([
  ...new Set(original.map((c) => c.file)),
  ...[
    "impact-fixture.mjs",
    "impact-worker.mjs",
    "impact-corpus-v2.json",
    "impact-corpus.json",
    "impact-metrics.mjs",
  ].map((file) => "scripts/" + file),
  "scripts/consumer-foundation-evidence.mjs",
  "docs/measurements/impact-darwin-arm64-node26.json",
  "docs/measurements/impact-linux-arm64-node22.json",
]);
export function selectConsumerFoundation(profiles) {
  assert.deepEqual(
    profiles["consumer-impact-foundation"],
    original,
    "Original consumer foundation changed",
  );
  return {
    requirements: original.map((c) => ({ ...c })),
    events: [...original, ...nested].map((c) => ({ ...c })),
  };
}
export function requireConsumerFoundationEvidence(
  evidence,
  selection,
  digests,
) {
  const { requirements, events: expectedEventRows } = selection;
  assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
  assert.deepEqual(evidence.problems, []);
  assert.equal(evidence.required, requirements.length);
  assert.equal(evidence.passed, expectedEventRows.length);
  const ledger = evidence.ledger;
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.truncated, false);
  assert.equal(ledger.terminalEventCount, expectedEventRows.length);
  assert.equal(ledger.events.length, expectedEventRows.length);
  assert.equal(ledger.cases.length, requirements.length);
  const files = [...new Set(requirements.map((c) => c.file))];
  assert.equal(ledger.files.length, files.length);
  const ids = new Map();
  for (const [index, file] of files.entries()) {
    const row = ledger.files[index];
    assert.equal(typeof row.id, "string");
    assert.ok(row.id.length > 0);
    assert.ok(!ids.has(row.id), "Duplicate foundation file identity");
    ids.set(row.id, file);
    assert.match(digests[file] ?? "", /^[a-f0-9]{64}$/);
    assert.equal(row.stable, true);
    assert.deepEqual(row.before, { state: "present", sha256: digests[file] });
    assert.deepEqual(row.after, row.before);
  }
  const key = (c) => JSON.stringify([c.file, c.name]);
  const required = new Set(requirements.map(key));
  assert.equal(required.size, requirements.length);
  const expected = new Set(expectedEventRows.map(key));
  assert.equal(expected.size, expectedEventRows.length);
  const events = new Map();
  for (const [index, event] of ledger.events.entries()) {
    assert.equal(event.sequence, index + 1);
    const id = key({ file: ids.get(event.fileId), name: event.name });
    assert.ok(expected.has(id), "Unexpected foundation event");
    assert.ok(!events.has(id), "Duplicate foundation event");
    assert.equal(event.kind, "test");
    assert.equal(event.outcome, "passed");
    assert.equal(event.required, required.has(id));
    assert.equal(event.nameTruncated, false);
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    events.set(id, event);
  }
  const seen = new Set();
  for (const item of ledger.cases) {
    const id = key({ file: ids.get(item.fileId), name: item.name });
    assert.ok(required.has(id), "Unexpected foundation case");
    assert.ok(!seen.has(id), "Duplicate foundation case");
    seen.add(id);
    assert.equal(item.outcome, "passed");
    assert.deepEqual(item.terminalSequences, [events.get(id).sequence]);
  }
  assert.equal(seen.size, requirements.length);
  return evidence;
}

export async function runConsumerFoundation(root, selection, digests, profile) {
  const evidence = await runRequiredTests(
    selection.requirements.map((c) => ({
      ...c,
      file: path.join(root, c.file),
    })),
    {
      timeoutMs: 300000,
      isolatedCaseWorkers: 1,
      onCaseProgress: (event) =>
        process.stderr.write(JSON.stringify({ profile, ...event }) + "\n"),
    },
  );
  if (!evidence.complete)
    process.stderr.write(
      JSON.stringify({
        profile,
        phase: "incomplete",
        problems: evidence.problems,
      }) + "\n",
    );
  return requireConsumerFoundationEvidence(evidence, selection, digests);
}
