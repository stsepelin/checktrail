import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { open, realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { run } from "node:test";

export const testFileWorkerLimit = () =>
  Math.max(1, Math.min(4, availableParallelism()));

const exclusiveFullSuiteFiles = Object.freeze([
  "gate-javascript-extensions.test.js",
  "gate-tasks-matrix.test.js",
  "gate-resource-release-readiness.test.js",
  "gate-go-extensions.test.js",
  "gate-lifecycle-platforms.test.js",
  "go-matrix.test.js",
  "process-tree.test.js",
  "posix-owner.test.js",
  "clang.test.js",
  "review-json-probe.test.js",
  "review-probe.test.js",
]);
function isExclusiveFullSuiteFile(file, directory) {
  return exclusiveFullSuiteFiles.some(
    (name) => file === path.join(directory, name),
  );
}
export function fullSuiteBatches(files) {
  const exclusive = new Set(exclusiveFullSuiteFiles);
  return [
    {
      exclusive: false,
      files: files.filter((file) => !exclusive.has(path.basename(file))),
    },
    {
      exclusive: true,
      files: files.filter((file) => exclusive.has(path.basename(file))),
    },
  ].filter((batch) => batch.files.length > 0);
}

const MAX_REQUIREMENTS = 256;
const MAX_EVENTS = 4096;
const MAX_NAME_CHARACTERS = 512;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
// Inspect the original cause stack in memory. Only exact bound source frames
// with one unambiguous, physically possible location become numeric metadata.
export function boundTestFailureSite(stack, source) {
  try {
    if (typeof stack !== "string" || stack.length > 65536 || !source)
      return undefined;
    const frames = stack.split("\n");
    if (frames.length > 256) return undefined;
    const sites = new Map();
    for (const frame of frames.slice(1)) {
      const call = frame.match(/^ {4}at (.+)$/);
      if (!call) continue;
      const location = call[1].endsWith(")")
        ? call[1].match(/^[^()\r\n]+ \((.+)\)$/)?.[1]
        : call[1];
      const match = location?.match(/^(.*):([1-9][0-9]*):([1-9][0-9]*)$/);
      if (!match || (match[1] !== source.file && match[1] !== source.url))
        continue;
      const line = Number(match[2]),
        column = Number(match[3]);
      if (
        !Number.isSafeInteger(line) ||
        !Number.isSafeInteger(column) ||
        line > source.lineLengths.length ||
        column > source.lineLengths[line - 1] + 1
      )
        return undefined;
      sites.set(`${line}:${column}`, {
        sourceFileSha256: source.sha256,
        line,
        column,
      });
    }
    return sites.size === 1 ? sites.values().next().value : undefined;
  } catch {
    return undefined;
  }
}
const key = ({ file, name }) => JSON.stringify([file, name]);
const fingerprint = async (file, captureSource) => {
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
      limit = MAX_SOURCE_BYTES,
      chunks = captureSource ? [] : null;
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
      chunks?.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const sha256 = digest.digest("hex");
    if (chunks)
      captureSource({
        file,
        url: pathToFileURL(file).href,
        sha256,
        lineLengths: Buffer.concat(chunks)
          .toString("utf8")
          .split("\n")
          .map((line) => (line.endsWith("\r") ? line.length - 1 : line.length)),
      });
    return { state: "present", sha256 };
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
    isolatedCaseWorkers = 0,
    onCaseProgress,
    diagnosticSourceFile,
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
  assert.ok(
    Number.isSafeInteger(isolatedCaseWorkers) &&
      isolatedCaseWorkers >= 0 &&
      isolatedCaseWorkers <= 2,
    "Required case worker limit must be bounded",
  );
  assert.ok(
    isolatedCaseWorkers === 0 || additionalFiles.length === 0,
    "Named case isolation cannot replace a full-suite run",
  );
  assert.ok(
    onCaseProgress === undefined ||
      (typeof onCaseProgress === "function" && isolatedCaseWorkers > 0),
    "Required case progress needs named isolation",
  );
  const requiredCaseWorkerLimit =
    isolatedCaseWorkers === 0
      ? 0
      : Math.min(isolatedCaseWorkers, availableParallelism());
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
  // These native files repeat loader/build or Tasks fresh-install controls. Give
  // each complete file an exclusive slot after the shared full-suite wave; named
  // selection would omit unlisted callbacks. All existing deadlines still apply.
  const exclusiveFiles =
    additionalFiles.length > 0
      ? files.filter((file) =>
          isExclusiveFullSuiteFile(
            file,
            fileURLToPath(new URL("../dist/test/", import.meta.url)),
          ),
        )
      : [];
  const exclusiveSet = new Set(exclusiveFiles);
  const failureSources = new Map();
  const before = await Promise.all(
    files.map((file) =>
      fingerprint(
        file,
        file === diagnosticSourceFile
          ? (source) => failureSources.set(file, source)
          : undefined,
      ),
    ),
  );
  const observed = new Map(expected.map((item) => [key(item), []]));
  const terminalEvents = [];
  const problems = [];
  let passed = 0;
  let optionalSkipped = 0;
  let terminalEventCount = 0;
  const collect = async (selection, batch = files, exclusive = false) => {
    let temporary;
    let execArgv = [];
    const cleanup = async () => {
      if (temporary) {
        try {
          await rm(temporary, {
            recursive: true,
            force: true,
            // Native owners can finish EOF cleanup after their test worker exits.
            // Bound both Windows locks and POSIX final-directory write races.
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch (error) {
          const failed = terminalEvents.filter(
            (event) => event.outcome === "failed",
          );
          const diagnostics = {
            schemaVersion: 1,
            profile: "required-native-case-cleanup-failure",
            case: selection?.name ?? null,
            fileIds: (selection ? [selection.file] : batch).map(
              (file) => fileIds.get(file) ?? null,
            ),
            code: typeof error?.code === "string" ? error.code : "unknown",
            observedPasses: passed,
            observedOptionalSkipped: optionalSkipped,
            terminalEventCount,
            retainedTerminalEvents: terminalEvents.length,
            terminalLedgerTruncated: terminalEventCount > terminalEvents.length,
            failedTerminalCount: failed.length,
            requiredFailedTerminalCount: failed.filter(
              (event) => event.required,
            ).length,
            failures: failed
              .slice(0, 64)
              .map(({ fileId, name, outcome, required }) => ({
                fileId,
                name,
                outcome,
                required,
              })),
            failureDetailsTruncated: failed.length > 64,
            sourceStabilityAssessed: false,
            evidenceComplete: false,
          };
          if (error && typeof error === "object") {
            try {
              error.nativeTestEvidence = diagnostics;
            } catch {
              /* Preserve the original cleanup error. */
            }
          }
          process.stderr.write(JSON.stringify(diagnostics) + "\n");
          throw error;
        }
      }
    };
    try {
      if (selection) onCaseProgress?.({ phase: "start", name: selection.name });
      if (selection || exclusive) {
        temporary = await mkdtemp(
          path.join(tmpdir(), "checktrail-native-case-"),
        );
        const preload = path.join(temporary, "environment.mjs");
        await writeFile(
          preload,
          `import process from "node:process";for(const name of ["TMPDIR","TEMP","TMP"])process.env[name]=${JSON.stringify(temporary)};`,
          { flag: "wx", mode: 0o600 },
        );
        execArgv = ["--import", pathToFileURL(preload).href];
      }
      // Exact isolated installed wrappers repeat a complete native cohort. Their
      // parent observation allowance does not change native command deadlines.
      // Other callback names, paths and caller-selected budgets stay unchanged.
      const caseTimeoutMs =
        timeoutMs === 120000 &&
        selection?.file ===
          path.join(
            fileURLToPath(new URL("../dist/test/", import.meta.url)),
            "gate-assembly-fastapi.test.js",
          ) &&
        selection.name === "assembly-fastapi installed acceptance"
          ? 300000
          : process.platform === "win32" &&
              timeoutMs === 600000 &&
              selection?.file ===
                path.join(
                  fileURLToPath(new URL("../dist/test/", import.meta.url)),
                  "gate-consumer-impact.test.js",
                ) &&
              selection.name === "consumer-impact installed acceptance"
            ? 1200000
            : timeoutMs === 600000 &&
                [
                  "dotnet-generator-extensions",
                  "ruby-extensions",
                  "swift-extensions",
                  "mutation-runners",
                  "attempt-archives",
                ].some(
                  (profile) =>
                    selection?.file ===
                      path.join(
                        fileURLToPath(
                          new URL("../dist/test/", import.meta.url),
                        ),
                        `gate-${profile}.test.js`,
                      ) && selection.name === `${profile} installed acceptance`,
                )
              ? 1200000
              : timeoutMs;
      for await (const { type, data } of run({
        files: selection ? [selection.file] : batch,
        concurrency: selection || exclusive ? 1 : fileWorkerLimit,
        timeout: caseTimeoutMs,
        execArgv,
        ...(selection
          ? {
              testNamePatterns: [
                new RegExp(
                  "^" +
                    selection.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "$",
                ),
              ],
            }
          : {}),
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
          if (selection && !suite && id === key(selection))
            onCaseProgress?.({
              phase: "terminal",
              name: selection.name,
              outcome,
              durationMs: event.durationMs,
              ...(type === "test:fail"
                ? {
                    ...(typeof data.details?.error?.failureType === "string"
                      ? {
                          failureType: data.details.error.failureType.slice(
                            0,
                            128,
                          ),
                        }
                      : {}),
                    ...(typeof data.details?.error?.code === "string"
                      ? { code: data.details.error.code.slice(0, 128) }
                      : {}),
                    ...(typeof data.details?.error?.message === "string"
                      ? { message: data.details.error.message.slice(0, 1000) }
                      : {}),
                  }
                : {}),
            });
          if (event.nameTruncated)
            problems.push({
              name: event.name,
              reason: "terminal-name-truncated",
            });
        }
        if (type === "test:fail" && retained) {
          const error = data.details?.error;
          const failureSite = boundTestFailureSite(
            error?.cause?.stack,
            failureSources.get(file),
          );
          problems.push({
            name: data.name.slice(0, MAX_NAME_CHARACTERS),
            reason: "failed",
            ...(failureSite ? { failureSite } : {}),
            ...(typeof error?.cause?.code === "string"
              ? { causeCode: error.cause.code.slice(0, 128) }
              : {}),
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
    } finally {
      await cleanup();
      if (selection)
        onCaseProgress?.({ phase: "finished", name: selection.name });
    }
  };
  if (before.every((item) => item.state === "present")) {
    if (requiredCaseWorkerLimit > 0) {
      let cursor = 0;
      const outcomes = await Promise.allSettled(
        Array.from({ length: requiredCaseWorkerLimit }, async () => {
          while (cursor < expected.length) await collect(expected[cursor++]);
        }),
      );
      // Wait for every running stream and namespace cleanup before propagating
      // a harness error. A rejected worker must not strand its peers.
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );
      if (rejected) throw rejected.reason;
    } else {
      const sharedFiles = files.filter((file) => !exclusiveSet.has(file));
      if (sharedFiles.length) await collect(null, sharedFiles);
      for (const file of exclusiveFiles) await collect(null, [file], true);
    }
  }
  const truncated = terminalEventCount > terminalEvents.length;
  if (truncated)
    problems.push({ name: "terminal-ledger", reason: "terminal-ledger-limit" });
  const after = await Promise.all(files.map((file) => fingerprint(file)));
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
    ...(exclusiveFiles.length > 0
      ? { exclusiveFullSuiteFileCount: exclusiveFiles.length }
      : {}),
    ...(requiredCaseWorkerLimit > 0
      ? {
          requiredCaseWorkerLimit,
          timeoutScope: "one fresh process per required named case",
        }
      : {}),
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

function selectDiagnosticSourceFile(requirements, expected, selected) {
  if (selected === undefined) return undefined;
  assert.ok(
    typeof selected === "string" &&
      selected.length > 0 &&
      selected.length <= 4096,
    "Diagnostic source selection must be a bounded path",
  );
  const resolved = path.resolve(selected);
  // Resolve only against inputs already normalized by resolveRequirements.
  // This option cannot admit another file read or add an execution target.
  const index = requirements.findIndex(
    (item, index) =>
      path.resolve(item.file) === resolved || expected[index].file === resolved,
  );
  assert.ok(index >= 0, "Diagnostic source must be a required test input");
  return expected[index].file;
}

export async function runRequiredTests(requirements, options = {}) {
  const expected = await resolveRequirements(requirements);
  return executeRequiredTests(expected, {
    ...options,
    diagnosticSourceFile: selectDiagnosticSourceFile(
      requirements,
      expected,
      options.diagnosticSourceFile,
    ),
  });
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
  const originalInputs = [],
    normalizedInputs = [];
  // Validate every manifest before executing any selected file.
  for (const profile of selection) {
    assert.ok(
      typeof profile === "string" && Object.hasOwn(profiles, profile),
      "Unknown required native test profile",
    );
    const expected = await resolveRequirements(profiles[profile]);
    originalInputs.push(...profiles[profile]);
    normalizedInputs.push(...expected);
    selected.push({ profile, required: expected.length });
    for (const item of expected) requirements.set(key(item), item);
  }
  // Every obligation needs a retained terminal event. Keep the batch bounded
  // by the ledger while preserving the narrower single-profile limit.
  assert.ok(
    requirements.size <= MAX_EVENTS,
    "Required profile batch exceeds terminal ledger bound",
  );
  const report = await executeRequiredTests([...requirements.values()], {
    ...options,
    diagnosticSourceFile: selectDiagnosticSourceFile(
      originalInputs,
      normalizedInputs,
      options.diagnosticSourceFile,
    ),
  });
  return { profiles: selected, ...report };
}
