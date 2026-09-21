import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

test("evaluation metrics retain incomplete cases and wrong diagnostic failures in their denominators", () => {
  const module = new URL(
    "../../scripts/evaluation-metrics.mjs",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const {summarizeEvaluation} = await import(process.argv[1]);
    const cases = ['defect', 'defect', 'defect', 'valid', 'valid', 'valid', 'insufficient-evidence', 'unsupported-profile'].map((label, index) => ({id: String(index), family: 'example', label}));
    const statuses = ['failed', 'failed', 'incomplete', 'passed', 'failed', 'incomplete', 'passed', 'incomplete'];
    const observations = statuses.map((outcome, index) => ({id: String(index), engine: {outcome, signalMatched: index !== 1, wallMs: 1}, native: {outcome, signalMatched: index !== 1, wallMs: 2}}));
    const [summary] = summarizeEvaluation(cases, observations);
    assert.equal(summary.cases, 8);
    assert.deepEqual(summary.systems.engine.detection, {numerator: 1, denominator: 3, fraction: 1/3});
    assert.deepEqual(summary.systems.engine.falsePositives, {numerator: 1, denominator: 3, fraction: 1/3});
    assert.equal(summary.systems.engine.wrongFailureSignal, 1);
    assert.equal(summary.systems.engine.incompleteValidCases, 1);
    assert.equal(summary.systems.engine.passesOnInsufficientEvidence, 1);
    assert.equal(summary.systems.engine.passesOnUnsupportedProfile, 0);
    assert.equal(summary.systems.engine.totalWallMs, 8);
    assert.equal(summary.systems.native.totalWallMs, 16);
    assert.deepEqual(summary.systems.engine.matrix.defect, {passed: 0, failed: 2, incomplete: 1});
    for (const items of [observations.slice(1), [...observations.slice(1), observations[1]], [...observations.slice(1), {...observations[0], id: 'unknown'}]]) {
      assert.throws(() => summarizeEvaluation(cases, items));
    }
    for (const invalid of [{outcome: 'unknown'}, {signalMatched: undefined}, {wallMs: -1}, {wallMs: NaN}]) {
      const items = structuredClone(observations);
      Object.assign(items[0].engine, invalid);
      assert.throws(() => summarizeEvaluation(cases, items));
    }
    assert.throws(() => summarizeEvaluation([], []));
  `,
      module,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("recorded evaluation counts reconcile with every raw case and the frozen corpus digest", () => {
  const repository = new URL("../../", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {createHash} from 'node:crypto';
    const root = process.argv[1];
    const {summarizeEvaluation} = await import(new URL('scripts/evaluation-metrics.mjs', root));
    const bytes = await readFile(new URL('scripts/evaluation-corpus.json', root));
    const corpus = JSON.parse(bytes);
    for (const name of ['evaluation-darwin-arm64-node26.json', 'evaluation-linux-arm64-node22.json']) {
      const text = await readFile(new URL('docs/measurements/' + name, root), 'utf8');
      const report = JSON.parse(text);
      assert.equal(report.identities.corpusSha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(report.corpus.id, corpus.id);
      assert.equal(report.corpus.cases, corpus.cases.length);
      assert.deepEqual(report.summaries, summarizeEvaluation(corpus.cases, report.observations));
      for (const item of corpus.cases) {
        const observation = report.observations.find((result) => result.id === item.id);
        assert.equal(observation.engine.signalMatched, !item.engineSignal || observation.engine.signals.includes(item.engineSignal));
        assert.equal(observation.fingerprint, observation.engine.sourceFingerprint);
        assert.equal(observation.files, Object.keys(item.files).length);
        assert.ok(observation.engine.tools.every((tool) => tool.name && tool.version));
      }
      assert.ok(!['/Users/', '/private/', '/workspace/', '/tmp/', '/home/'].some((prefix) => text.includes(prefix)));
    }
  `,
      repository,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("evaluation worker distinguishes assertion defects, runtime failures and empty tests without accepting an expected label", async (t) => {
  const worker = fileURLToPath(
    new URL("../../scripts/evaluation-worker.mjs", import.meta.url),
  );
  for (const [body, outcome, assertion] of [
    [passingTest, "passed", false],
    [passingTest.replace("2 + 3, 5", "2 + 3, 6"), "failed", true],
    [
      "import {test} from 'node:test'; test('runtime failure', () => { throw new Error('unrelated defect'); });",
      "failed",
      false,
    ],
    ["export const fixture = 1;", "incomplete", false],
  ] as const) {
    const root = await fixture(t, {
      "package.json": nodeManifest,
      "value.test.js": body,
    });
    const result = spawnSync(
      process.execPath,
      [worker, root, "javascript.node-test"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout) as {
      outcome: string;
      signals: string[];
      sourceFingerprint: string;
    };
    assert.equal(observation.outcome, outcome);
    assert.equal(observation.signals.includes("ERR_ASSERTION"), assertion);
    assert.match(observation.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(!result.stdout.includes(root));
  }
});
