import assert from "node:assert/strict";
import { runRequiredTests } from "./required-test-evidence.mjs";
import path from "node:path";
import process from "node:process";
const original = [
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation retains binary bytes and real process identities for successful and failed children in one ordered journal",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation preserves failed spawn evidence without manufacturing a PID and refuses exhausted admission before starting project code",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation leaves preaborted and invalid-bound calls unreached while retaining exact zero-output and exact-prefix controls",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation distinguishes journal exhaustion from a smaller caller output cap and keeps each observed prefix on failure",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation retains reached child bytes and identities across actual cancellation deadlines and observer failure",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation closes ordinary descendants retaining output pipes after root exit without inventing a successful timeout",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation respects mirror backpressure without dropping physical chunks and deadlines release a stalled drain",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation retains mirror failures before and after native exit and bounds pending writes without removing caller listeners",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "JVM invokers share one explicit native journal across quiet and observed calls and retain bytes rejected by strict decoding",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native invocation journal retains the reached physical prefix after its actual wrapper is killed before any final response",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native wrapper output adapter keeps binary evidence before parser decoding and preserves failed exit receipts",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native wrapper output adapter rejects invalid modes before admission and keeps reached prefixes on bounded failure",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "shipped native wrapper inventory awaits every migrated invocation and downstream collector without asynchronous predicate shortcuts",
  },
  {
    file: "dist/test/native-invoke.test.js",
    name: "native output receipt keeps physical exit codes separate from parser completion for zero nonzero and absent exits",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native capture preserves physical valid partial invalid and changed-header buffers while strict replay remains strict",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native capture revalidates every held file and directory boundary and preserves replacement safety",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native receipt schemas recompute physical replay and reject every false declaration and lifecycle error",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native producer catalog matches exact shipped entrypoints and exempts only the two metadata-only identity paths",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native protected process channel records two actual child PIDs and strips exact context aliases without stripping near misses",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native context initialization failures stay failed across retries before any child executes",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native outer launch uses the engine-owned context after stripping operator and command aliases",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "native cancelled outer wrappers retain reached raw prefixes without inventing completion after cleanup",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "engine journals preserve actual original adapter success and failure while discovery and untrusted runs execute nothing",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "engine wrapper journals are shared by native CLI and stateless MCP with startup-only trust and detailed receipts",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "engine collector retains physical bytes on producer changes and simulated cleanup failure and rejects empty capture",
  },
  {
    file: "dist/test/native-journal-engine.test.js",
    name: "engine refuses a zero-call successful wrapper and rejects a passed report with an incomplete current journal",
  },
  {
    file: "dist/test/native-attempt-storage.test.js",
    name: "native journal private storage preserves two distinct records and canonical physical data with closed and interrupted accounting",
  },
  {
    file: "dist/test/native-attempt-storage.test.js",
    name: "native journal physical file/header changes hard links and a foreign context reject before writes resume",
  },
  {
    file: "dist/test/native-attempt-storage.test.js",
    name: "native journal zero and exact prefixes bound disk data and cannot turn overrun into complete output",
  },
  {
    file: "dist/test/native-attempt-storage.test.js",
    name: "native journal directory replacement cannot redirect cleanup and weak POSIX access cannot be repaired silently",
  },
  {
    file: "dist/test/native-attempt-frames.test.js",
    name: "native journal replay retains two actual binary child outputs and distinct successful and failed exit observations",
  },
  {
    file: "dist/test/native-attempt-frames.test.js",
    name: "native journal omitted and unconfirmed interrupted calls remain incomplete without invented successful terminals",
  },
  {
    file: "dist/test/native-attempt-frames.test.js",
    name: "native journal physical hashes ordering identities counts lifecycle and source/operator limits reject independent contradictions",
  },
  {
    file: "dist/test/native-attempt-frames.test.js",
    name: "native journal exact zero and overrun shared prefixes cannot become complete or resume retained bytes",
  },
  {
    file: "dist/test/native-attempt-frames.test.js",
    name: "native journal error causes and concurrent process acknowledgements reject contradictions while sequential PID reuse and observed transport errors remain distinct",
  },
  {
    file: "dist/test/process-output.test.js",
    name: "physical process output retains exact binary stdout stderr and digests while default presentation stays unchanged",
  },
  {
    file: "dist/test/process-output.test.js",
    name: "physical output zero exact and multibyte overrun limits distinguish delivered bytes from UTF8 replacements",
  },
  {
    file: "dist/test/process-output.test.js",
    name: "physical output codec reconciles canonical bytes digests combined ceilings and a large valid boundary",
  },
  {
    file: "dist/test/process-output.test.js",
    name: "physical output invalid admission limits reject before a project command can execute",
  },
  {
    file: "dist/test/attempt-archive.test.js",
    name: "native validation retains physical command output while summary omits every byte archive",
  },
  {
    file: "dist/test/attempt-archive.test.js",
    name: "offline API attempts retain each bounded JSON error and response with exact request/body bindings without credentials or summary disclosure",
  },
  {
    file: "dist/test/attempt-archive.test.js",
    name: "offline API response archives refuse literal and JSON-escaped credentials while keeping a valid adjacent value",
  },
  {
    file: "dist/test/attempt-archive.test.js",
    name: "offline API partial overflow aborted and unavailable attempts account for observed bytes without retaining an unchecked body",
  },
  {
    file: "dist/test/attempt-archive.test.js",
    name: "retained model response archives reject omitted foreign reordered changed and noncanonical evidence independently",
  },
  {
    file: "dist/test/attempt-archive-native.test.js",
    name: "native version and broken/fixed test commands retain physical output with exact two-case accounting",
  },
];
const posixOnly =
  "native invocation closes ordinary descendants retaining output pipes after root exit without inventing a successful timeout";
export const attemptFoundationFiles = Object.freeze([
  ...new Set(original.map((c) => c.file)),
]);
export function selectAttemptFoundation(profiles, platform = process.platform) {
  assert.ok(
    ["darwin", "linux", "win32"].includes(platform),
    "Unsupported attempt foundation platform",
  );
  assert.deepEqual(
    profiles["attempt-journal-foundation"],
    original.slice(0, 35),
    "Original journal/invocation callbacks changed",
  );
  assert.deepEqual(
    profiles["attempt-output-foundation"],
    original.slice(35),
    "Original physical output/archive callbacks changed",
  );
  const exclusions =
    platform === "win32"
      ? original
          .filter((c) => c.name === posixOnly)
          .map((c) => ({
            ...c,
            reason:
              "POSIX descendant ownership requires a native POSIX runtime",
          }))
      : [];
  return {
    requirements: original
      .filter(
        (c) => !exclusions.some((x) => x.file === c.file && x.name === c.name),
      )
      .map((c) => ({ ...c })),
    exclusions,
  };
}
export function requireAttemptFoundationEvidence(
  evidence,
  requirements,
  digests,
) {
  assert.equal(evidence.complete, true, JSON.stringify(evidence.problems));
  assert.deepEqual(evidence.problems, []);
  assert.equal(evidence.required, requirements.length);
  assert.equal(evidence.passed, requirements.length);
  const ledger = evidence.ledger;
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(ledger.truncated, false);
  assert.equal(ledger.terminalEventCount, requirements.length);
  assert.equal(ledger.events.length, requirements.length);
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
  const expected = new Set(requirements.map(key));
  assert.equal(expected.size, requirements.length);
  const events = new Map();
  for (const [index, event] of ledger.events.entries()) {
    assert.equal(event.sequence, index + 1);
    const id = key({ file: ids.get(event.fileId), name: event.name });
    assert.ok(expected.has(id), "Unexpected foundation event");
    assert.ok(!events.has(id), "Duplicate foundation event");
    assert.equal(event.kind, "test");
    assert.equal(event.outcome, "passed");
    assert.equal(event.required, true);
    assert.equal(event.nameTruncated, false);
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    events.set(id, event);
  }
  const seen = new Set();
  for (const item of ledger.cases) {
    const id = key({ file: ids.get(item.fileId), name: item.name });
    assert.ok(expected.has(id), "Unexpected foundation case");
    assert.ok(!seen.has(id), "Duplicate foundation case");
    seen.add(id);
    assert.equal(item.outcome, "passed");
    assert.deepEqual(item.terminalSequences, [events.get(id).sequence]);
  }
  assert.equal(seen.size, requirements.length);
  return evidence;
}
export async function runAttemptFoundation(root, selection, digests, profile) {
  const evidence = await runRequiredTests(
    selection.requirements.map((c) => ({
      ...c,
      file: path.join(root, c.file),
    })),
    {
      timeoutMs: process.platform === "win32" ? 600000 : 300000,
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
  return requireAttemptFoundationEvidence(
    evidence,
    selection.requirements,
    digests,
  );
}
