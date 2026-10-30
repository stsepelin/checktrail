import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCapturedProcessOutput } from "../dist/src/process-output.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
export function consumerAttemptState(value) {
  const result = value.result;
  if (
    result.cancelled &&
    !result.timedOut &&
    !result.truncated &&
    result.durationMs === 0 &&
    result.exitCode === null &&
    result.signal === null &&
    result.errorCode === null &&
    value.output === null
  )
    return "not-started";
  if (result.timedOut) return "timed-out";
  if (result.cancelled) return "cancelled";
  if (result.truncated) return "output-truncated";
  if (
    result.errorCode !== null ||
    value.output === null ||
    !value.nativeTerminalObserved
  )
    return "unavailable";
  return result.exitCode === 0 ? "passed" : "failed";
}
/** Validate retained ProcessResult observations, without manufacturing PID or stream-order evidence. */
export function inspectConsumerAttemptRecords(records) {
  assert.ok(
    Array.isArray(records) && records.length <= 512,
    "Consumer attempt inventory exceeds bound",
  );
  const found = new Map();
  let total = 0;
  for (const item of records) {
    const value = item.value;
    assert.equal(value?.schemaVersion, 1);
    assert.equal(value.profile, "consumer-process-result-observation-v1");
    assert.ok(
      uuid(value.attemptId) && uuid(value.witnessId),
      "Invalid consumer attempt identity",
    );
    assert.equal(item.file, "attempt-" + value.attemptId + ".json");
    assert.equal(
      found.has(value.attemptId),
      false,
      "Duplicate consumer attempt identity",
    );
    assert.ok(
      ["go", "python", "php", "rust", "ruby", "c", "cpp"].includes(
        value.family,
      ),
    );
    assert.ok(["broken", "fixed", "near-miss"].includes(value.variant));
    assert.ok(["source", "installed"].includes(value.origin));
    assert.ok(
      ["canonical", "caller-change", "restored", "repeat"].includes(
        value.phase,
      ),
    );
    assert.ok(
      value.stage === "consumer" ||
        (value.stage === "compiler" &&
          ["rust", "c", "cpp"].includes(value.family)),
    );
    assert.equal(value.processStartAcknowledgementRetained, false);
    assert.equal(value.gateAComplete, false);
    assert.ok(
      Array.isArray(value.before) &&
        value.before.length >= 2 &&
        value.before.length <= 32,
    );
    for (const file of value.before) {
      assert.ok(
        typeof file.path === "string" &&
          file.path.length <= 512 &&
          !/[\\\0:]/.test(file.path) &&
          file.path
            .split("/")
            .every((part) => part && part !== "." && part !== ".."),
      );
      assert.ok(
        Number.isSafeInteger(file.bytes) &&
          file.bytes >= 0 &&
          file.bytes <= 1048576 &&
          digest(file.sha256),
      );
    }
    assert.ok(value.after === null || Array.isArray(value.after));
    assert.ok(
      digest(value.commandSha256) &&
        digest(value.argvSha256) &&
        digest(value.executableSha256),
    );
    assert.ok(
      value.executableAfterSha256 === null ||
        digest(value.executableAfterSha256),
    );
    assert.ok(
      value.identityError === null ||
        (typeof value.identityError === "string" &&
          value.identityError.length <= 1024),
    );
    const result = value.result;
    assert.ok(
      result && Number.isFinite(result.durationMs) && result.durationMs >= 0,
    );
    assert.ok(
      result.exitCode === null ||
        (Number.isSafeInteger(result.exitCode) && result.exitCode >= 0),
    );
    assert.ok(
      result.signal === null ||
        (typeof result.signal === "string" &&
          /^SIG[A-Z0-9]+$/.test(result.signal)),
    );
    assert.ok(
      result.errorCode === null ||
        (typeof result.errorCode === "string" &&
          result.errorCode.length <= 128),
    );
    for (const flag of ["timedOut", "cancelled", "truncated"])
      assert.equal(typeof result[flag], "boolean");
    assert.equal(
      value.nativeTerminalObserved,
      result.exitCode !== null || result.signal !== null,
    );
    assert.equal(
      value.cleanupComplete,
      result.errorCode === null &&
        (value.nativeTerminalObserved || value.state === "not-started"),
    );
    if (value.output !== null) {
      const output = parseCapturedProcessOutput(value.output);
      assert.ok(
        output.stdout.bytes <= 65536 && output.stderr.bytes <= 65536,
        "Consumer attempt stream exceeds bound",
      );
      assert.equal(
        value.outputState,
        output.completeForObservedStreams ? "complete" : "incomplete",
      );
    } else assert.equal(value.outputState, "unavailable");
    assert.equal(
      value.state,
      consumerAttemptState(value),
      "Consumer attempt state differs from native result",
    );
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    assert.ok(bytes.length <= 262144);
    assert.equal(
      item.bytes,
      bytes.length,
      "Consumer attempt file byte count differs",
    );
    assert.equal(
      item.sha256,
      hash(bytes),
      "Consumer attempt file digest differs",
    );
    total += bytes.length;
    assert.ok(
      total <= 32 * 1048576,
      "Consumer attempt aggregate byte bound exceeded",
    );
    found.set(value.attemptId, item);
  }
  return { records: found, retainedBytes: total };
}
export function requireConsumerWitnessAttempts(witness, records, used) {
  assert.ok(uuid(witness.witnessId), "Missing consumer witness identity");
  const stages = ["rust", "c", "cpp"].includes(witness.family)
    ? ["compiler", "consumer"]
    : ["consumer"];
  assert.ok(Array.isArray(witness.attempts));
  assert.deepEqual(
    witness.attempts.map((item) => item.stage),
    stages,
    "Consumer attempt stage inventory differs",
  );
  for (const reference of witness.attempts) {
    const item = records.get(reference.attemptId);
    assert.ok(item, "Missing private consumer attempt record");
    assert.equal(
      used.has(reference.attemptId),
      false,
      "Consumer attempt reused by multiple witnesses",
    );
    assert.deepEqual(
      reference,
      {
        stage: item.value.stage,
        attemptId: item.value.attemptId,
        file: item.file,
        bytes: item.bytes,
        sha256: item.sha256,
      },
      "Consumer attempt reference differs from retained bytes",
    );
    const value = item.value;
    for (const key of ["witnessId", "family", "variant", "origin", "phase"])
      assert.equal(value[key], witness[key], "Foreign consumer attempt " + key);
    assert.deepEqual(value.before, witness.before);
    assert.deepEqual(value.after, witness.after);
    assert.equal(value.identityError, null);
    assert.equal(
      value.state,
      "passed",
      "Failed or unavailable native attempt cannot qualify a witness",
    );
    assert.equal(value.outputState, "complete");
    assert.equal(value.cleanupComplete, true);
    assert.equal(value.executableAfterSha256, value.executableSha256);
    const invocation =
      value.stage === "compiler" ? witness.compiler : witness.invocation;
    assert.ok(invocation);
    for (const key of [
      "exitCode",
      "signal",
      "errorCode",
      "timedOut",
      "cancelled",
      "truncated",
    ])
      assert.equal(
        value.result[key],
        invocation[key],
        "Consumer attempt terminal binding differs",
      );
    for (const key of [
      "commandSha256",
      "argvSha256",
      "executableSha256",
      "executableAfterSha256",
    ])
      assert.equal(
        value[key],
        invocation[key],
        "Consumer attempt invocation binding differs",
      );
    assert.ok(
      isDeepStrictEqual(
        value.output,
        value.stage === "compiler" ? witness.compiler.output : witness.output,
      ),
      "Consumer attempt physical output differs",
    );
    used.add(reference.attemptId);
  }
}
