import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { availableParallelism } from "node:os";
import { run } from "node:test";

export const testFileWorkerLimit = () =>
  Math.max(1, Math.min(4, availableParallelism()));

const MAX_REQUIREMENTS = 256;
const MAX_EVENTS = 4096;
const MAX_NAME_CHARACTERS = 512;
const key = ({ file, name }) => JSON.stringify([file, name]);
const fingerprint = async (file) => {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile())
      return { state: "unavailable", code: "not-regular" };
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536),
      limit = 4 * 1024 * 1024;
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limit + 1 - total),
        null,
      );
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit)
        return { state: "unavailable", code: "file-byte-limit" };
      digest.update(buffer.subarray(0, bytesRead));
    }
    return { state: "present", sha256: digest.digest("hex") };
  } catch (error) {
    return {
      state: "unavailable",
      code: typeof error.code === "string" ? error.code : "unknown",
    };
  } finally {
    await handle?.close();
  }
};
const sameFingerprint = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

async function executeRequiredTests(
  expected,
  {
    timeoutMs = 120000,
    maxTerminalEvents = MAX_EVENTS,
    additionalFiles = [],
  } = {},
) {
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000,
    "Required test harness timeout must be bounded",
  );
  assert.ok(
    Number.isSafeInteger(maxTerminalEvents) &&
      maxTerminalEvents > 0 &&
      maxTerminalEvents <= MAX_EVENTS,
    "Required terminal ledger must be bounded",
  );
  assert.ok(Array.isArray(additionalFiles));
  const fileWorkerLimit =
    additionalFiles.length > 0 ? testFileWorkerLimit() : 1;
  const requiredFiles = new Set(expected.map((item) => item.file));
  const optionalFiles = new Set(
    await Promise.all(additionalFiles.map((file) => realpath(file))),
  );
  const expectedKeys = new Set(expected.map(key));
  assert.equal(expectedKeys.size, expected.length);
  const files = [...new Set([...requiredFiles, ...optionalFiles])];
  const fileIds = new Map(
    files.map((file, index) => [file, "file-" + (index + 1)]),
  );
  const before = await Promise.all(files.map(fingerprint));
  const observed = new Map(expected.map((item) => [key(item), []]));
  const terminalEvents = [];
  const problems = [];
  let passed = 0;
  let optionalSkipped = 0;
  let terminalEventCount = 0;
  if (before.every((item) => item.state === "present"))
    for await (const { type, data } of run({
      files,
      concurrency: fileWorkerLimit,
      timeout: timeoutMs,
      execArgv: [],
    })) {
      if (type !== "test:pass" && type !== "test:fail") continue;
      terminalEventCount++;
      const suite = data.details?.type === "suite";
      const skipped = data.skip !== undefined && data.skip !== false;
      const todo = data.todo !== undefined && data.todo !== false;
      const outcome = skipped
        ? "skipped"
        : todo
          ? "todo"
          : type === "test:fail"
            ? "failed"
            : "passed";
      const file = data.file ? path.resolve(data.file) : "";
      const id = key({ file, name: data.name });
      const duration = data.details?.duration_ms;
      const retained = terminalEvents.length < maxTerminalEvents;
      if (retained) {
        const event = {
          sequence: terminalEventCount,
          fileId: fileIds.get(file) ?? null,
          name: data.name.slice(0, MAX_NAME_CHARACTERS),
          nameTruncated: data.name.length > MAX_NAME_CHARACTERS,
          kind: suite ? "suite" : "test",
          outcome,
          durationMs:
            typeof duration === "number" &&
            Number.isFinite(duration) &&
            duration >= 0
              ? duration
              : null,
          required: !suite && expectedKeys.has(id),
        };
        terminalEvents.push(event);
        if (!suite && observed.has(id)) observed.get(id).push(event.sequence);
        if (event.nameTruncated)
          problems.push({
            name: event.name,
            reason: "terminal-name-truncated",
          });
      }
      if (type === "test:fail" && retained) {
        const error = data.details?.error;
        problems.push({
          name: data.name.slice(0, MAX_NAME_CHARACTERS),
          reason: "failed",
          ...(typeof error?.failureType === "string"
            ? { failureType: error.failureType.slice(0, 128) }
            : {}),
          ...(typeof error?.code === "string"
            ? { code: error.code.slice(0, 128) }
            : {}),
          ...(typeof error?.message === "string"
            ? { message: error.message.slice(0, 1000) }
            : {}),
        });
      }
      if (skipped || todo) {
        if (
          skipped &&
          !todo &&
          optionalFiles.has(file) &&
          !requiredFiles.has(file)
        ) {
          optionalSkipped++;
        } else if (retained) {
          problems.push({
            name: data.name.slice(0, MAX_NAME_CHARACTERS),
            reason: "skipped-or-todo",
          });
        }
        continue;
      }
      if (type === "test:pass" && !suite) passed++;
    }
  const truncated = terminalEventCount > terminalEvents.length;
  if (truncated)
    problems.push({ name: "terminal-ledger", reason: "terminal-ledger-limit" });
  const after = await Promise.all(files.map(fingerprint));
  const fileEvidence = files.map((file, index) => {
    const stable =
      before[index].state === "present" &&
      sameFingerprint(before[index], after[index]);
    if (!stable)
      problems.push({
        name: fileIds.get(file),
        reason: "required-file-unavailable-or-changed",
      });
    return {
      id: fileIds.get(file),
      before: before[index],
      after: after[index],
      stable,
    };
  });
  const cases = expected.map((item) => {
    const sequences = observed.get(key(item));
    const events = sequences.map((sequence) => terminalEvents[sequence - 1]);
    const passes = events.filter((event) => event.outcome === "passed").length;
    if (passes !== 1 || events.length !== 1)
      problems.push({
        name: item.name,
        reason:
          passes > 1 || events.length > 1
            ? "duplicate-required-test"
            : "required-test-not-passed",
      });
    return {
      fileId: fileIds.get(item.file),
      name: item.name,
      outcome:
        events.length === 0
          ? "not-observed"
          : events.length > 1
            ? "duplicate"
            : events[0].outcome,
      terminalSequences: sequences,
    };
  });
  return {
    fileWorkerLimit,
    passed,
    required: expected.length,
    problems,
    complete: problems.length === 0,
    ...(additionalFiles.length > 0
      ? { files: files.length, optionalSkipped }
      : {}),
    ledger: {
      schemaVersion: 1,
      scope:
        "Selected test files and terminal test events; imported source, dependencies, raw output and whole-process identity are not captured.",
      maxTerminalEvents,
      terminalEventCount,
      truncated,
      files: fileEvidence,
      events: terminalEvents,
      cases,
    },
  };
}

async function resolveRequirements(requirements) {
  assert.ok(
    Array.isArray(requirements) &&
      requirements.length > 0 &&
      requirements.length <= MAX_REQUIREMENTS,
  );
  const expected = await Promise.all(
    requirements.map(async ({ file, name }) => {
      assert.ok(
        typeof file === "string" &&
          file.length > 0 &&
          file.length <= 4096 &&
          typeof name === "string" &&
          name.length > 0 &&
          name.length <= MAX_NAME_CHARACTERS,
      );
      const resolved = await realpath(file).catch((error) => {
        if (error.code === "ENOENT") return path.resolve(file);
        throw error;
      });
      return { file: resolved, name };
    }),
  );
  assert.equal(new Set(expected.map(key)).size, expected.length);
  return expected;
}

export async function runRequiredTests(requirements, options = {}) {
  return executeRequiredTests(await resolveRequirements(requirements), options);
}

export async function runRequiredProfiles(profiles, selection, options = {}) {
  assert.ok(
    Array.isArray(selection) &&
      selection.length > 0 &&
      selection.length <= MAX_REQUIREMENTS,
  );
  assert.equal(new Set(selection).size, selection.length, "Duplicate profile");
  const selected = [];
  const requirements = new Map();
  // Validate every manifest before executing any selected file.
  for (const profile of selection) {
    assert.ok(
      typeof profile === "string" && Object.hasOwn(profiles, profile),
      "Unknown required native test profile",
    );
    const expected = await resolveRequirements(profiles[profile]);
    selected.push({ profile, required: expected.length });
    for (const item of expected) requirements.set(key(item), item);
  }
  // Every obligation needs a retained terminal event. Keep the batch bounded
  // by the ledger while preserving the narrower single-profile limit.
  assert.ok(
    requirements.size <= MAX_EVENTS,
    "Required profile batch exceeds terminal ledger bound",
  );
  const report = await executeRequiredTests(
    [...requirements.values()],
    options,
  );
  return { profiles: selected, ...report };
}
