import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import { openTaskStore } from "../src/task-store.js";
import { reportSchema } from "../src/schemas.js";
import {
  archiveHash,
  archiveFixture,
  archiveNativeWitness,
  archivePolicies,
  runArchiveWitness,
} from "./attempt-whole-fixture.js";

test(
  "native archive witness executes both affected consumers and retains every failed and successful case with the actual child PID",
  { timeout: 90000 },
  async (t) => {
    const { report } = await runArchiveWitness(t, "broken");
    reportSchema.parse(report);
    assert.equal(report.outcome, "failed");
    assert.equal(report.sourceChanged, false);
    const witness = archiveNativeWitness(report);
    assert.equal(witness.attempt.exitCode, 1);
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 2,
      failed: 2,
      skipped: 0,
    });
    assert.deepEqual(
      witness.cases.filter((c) => !c.passed).map((c) => [c.consumer, c.input]),
      [
        ["first.mjs", "granting"],
        ["second.mjs", "granting"],
      ],
    );
  },
);

test(
  "native archive repair changes the captured producer while preserving consumer cases operator identity and independent process records",
  { timeout: 180000 },
  async (t) => {
    const d = await archiveFixture(t, "broken");
    const broken = await validate(d.root, d.options);
    assert.equal(broken.outcome, "failed");
    const before = archiveNativeWitness(broken);
    await writeFile(path.join(d.root, "decision.mjs"), archivePolicies.fixed);
    const fixed = await validate(d.root, d.options);
    reportSchema.parse(fixed);
    assert.equal(fixed.outcome, "passed");
    const after = archiveNativeWitness(fixed);
    assert.notEqual(broken.sourceFingerprint, fixed.sourceFingerprint);
    assert.equal(broken.policyFingerprint, fixed.policyFingerprint);
    assert.notEqual(
      before.journal.expectedHeader.journalId,
      after.journal.expectedHeader.journalId,
    );
    assert.notEqual(before.attempt.id, after.attempt.id);
    assert.deepEqual(fixed.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
    assert.deepEqual(
      after.cases.map((c) => [c.consumer, c.input, c.expected]),
      before.cases.map((c) => [c.consumer, c.input, c.expected]),
    );
    assert.ok(after.cases.every((c) => c.passed));
  },
);

test(
  "native archive valid alternate producer syntax leaves adjacent identifiers denied through both distinct consumer outputs",
  { timeout: 90000 },
  async (t) => {
    const { report } = await runArchiveWitness(t, "near");
    reportSchema.parse(report);
    assert.equal(report.outcome, "passed");
    const witness = archiveNativeWitness(report);
    assert.equal(witness.attempt.exitCode, 0);
    assert.ok(witness.cases.every((c) => c.passed));
    assert.deepEqual(
      witness.cases.filter((c) => c.input === "granting").map((c) => c.actual),
      [false, false],
    );
    assert.deepEqual(report.checks[0]!.tests, {
      total: 4,
      passed: 4,
      failed: 0,
      skipped: 0,
    });
  },
);

test(
  "native archive storage reconstructs an actual multi-chunk report and the same physical journal after closing and reopening the store",
  { timeout: 180000 },
  async (t) => {
    const d = await archiveFixture(t, "fixed", { padding: true });
    const report = await validate(d.root, d.options);
    assert.equal(report.outcome, "passed");
    const witnessed = archiveNativeWitness(report);
    assert.ok(witnessed.attempt.capturedOutput.stderr.bytes > 128 * 1024);
    const bytes = Buffer.from(JSON.stringify(report));
    assert.ok(
      bytes.length > 256 * 1024,
      "The actual native report must exceed the inline envelope",
    );
    const options = {
      root: d.root,
      directory: path.join(d.base, "private-store"),
      detailed: true,
    };
    let store = await openTaskStore(options);
    let taskId: string;
    try {
      const task = store.create(report.sourceFingerprint);
      taskId = task.taskId;
      assert.equal(store.completeWithArchive(taskId, report), "updated");
      assert.equal(store.get(taskId).status, "completed");
    } finally {
      store.close();
    }
    store = await openTaskStore(options);
    try {
      const first = store.readArchive(taskId, 0),
        chunks = [];
      assert.ok(first.archive.chunks > 1);
      assert.equal(first.archive.bytes, bytes.length);
      for (let i = 0; i < first.archive.chunks; i++) {
        const chunk = store.readArchive(taskId, i);
        assert.equal(chunk.index, i);
        assert.deepEqual(chunk.archive, first.archive);
        const data = Buffer.from(chunk.bodyBase64, "base64");
        assert.equal(data.length, chunk.bytes);
        assert.equal(archiveHash(data), chunk.sha256);
        chunks.push(data);
      }
      const restored = Buffer.concat(chunks);
      assert.ok(restored.equals(bytes));
      assert.equal(archiveHash(restored), first.archive.reportSha256);
      const reopened: typeof report = JSON.parse(restored.toString("utf8"));
      reportSchema.parse(reopened);
      const replay = archiveNativeWitness(reopened);
      assert.equal(replay.attempt.id, witnessed.attempt.id);
      assert.equal(
        replay.capture.framesData.sha256,
        witnessed.capture.framesData.sha256,
      );
      assert.deepEqual(replay.cases, witnessed.cases);
    } finally {
      store.close();
    }
  },
);

test(
  "native archive witness detects either consumer-only regression while the producer and unaffected caller remain unchanged",
  { timeout: 240000 },
  async (t) => {
    const d = await archiveFixture(t, "fixed"),
      producer = await readFile(path.join(d.root, "decision.mjs"));
    const baseline = await validate(d.root, d.options);
    assert.equal(baseline.outcome, "passed");
    archiveNativeWitness(baseline);
    const callers = [
      {
        name: "first.mjs",
        source:
          'import{allowed}from"./decision.mjs";export const consume=value=>({visible:!allowed(value)});\n',
      },
      {
        name: "second.mjs",
        source:
          'import{allowed}from"./decision.mjs";export const consume=value=>({state:allowed(value)?"blocked":"ready"});\n',
      },
    ];
    for (const caller of callers) {
      const file = path.join(d.root, caller.name),
        original = await readFile(file);
      try {
        await writeFile(file, caller.source);
        const changed = await validate(d.root, d.options);
        assert.equal(changed.outcome, "failed");
        const witness = archiveNativeWitness(changed);
        assert.notEqual(changed.sourceFingerprint, baseline.sourceFingerprint);
        assert.equal(changed.policyFingerprint, baseline.policyFingerprint);
        assert.deepEqual(
          await readFile(path.join(d.root, "decision.mjs")),
          producer,
        );
        assert.deepEqual(changed.checks[0]!.tests, {
          total: 4,
          passed: 2,
          failed: 2,
          skipped: 0,
        });
        assert.deepEqual(
          witness.cases.filter((c) => !c.passed).map((c) => c.consumer),
          [caller.name, caller.name],
        );
        assert.ok(
          witness.cases
            .filter((c) => c.consumer !== caller.name)
            .every((c) => c.passed),
        );
      } finally {
        await writeFile(file, original);
      }
    }
    const restored = await validate(d.root, d.options);
    assert.equal(restored.outcome, "passed");
    assert.equal(restored.sourceFingerprint, baseline.sourceFingerprint);
    archiveNativeWitness(restored);
  },
);
