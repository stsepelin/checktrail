import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  replayNativeAttemptFrames,
  type NativeJournalHeader,
  type NativeAttemptFrame,
} from "../src/native-attempt-frames.js";
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
function header(maxOutputBytes = 1024): NativeJournalHeader {
  return {
    schemaVersion: 1,
    format: "native-attempt-journal",
    journalId: randomUUID(),
    sourceFingerprint: hash("original source"),
    outerCommandSha256: hash("original outer command"),
    maxNativeCalls: 2,
    maxOutputBytes,
  };
}
function observations(h: NativeJournalHeader) {
  const frames: NativeAttemptFrame[] = [];
  const ids: string[] = [];
  const binaries: Buffer[] = [];
  for (const code of [0, 1]) {
    const id = randomUUID();
    ids.push(id);
    const program = `process.stdout.write(Buffer.from([0,255,195,169]));process.stderr.write(Buffer.from([255,0]));process.exitCode=${code};`;
    const command = { executable: process.execPath, args: ["-e", program] };
    const r = spawnSync(command.executable, command.args, {
      timeout: 10000,
      maxBuffer: 65536,
    });
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, code);
    assert.ok(r.pid > 1);
    frames.push({
      type: "admitted",
      journalId: h.journalId,
      sequence: frames.length,
      attemptId: id,
      commandSha256: hash(JSON.stringify(command)),
    });
    frames.push({
      type: "started",
      journalId: h.journalId,
      sequence: frames.length,
      attemptId: id,
      pid: r.pid,
    });
    for (const [stream, bytes] of [
      ["stdout", r.stdout],
      ["stderr", r.stderr],
    ] as const) {
      binaries.push(bytes);
      frames.push({
        type: "output",
        journalId: h.journalId,
        sequence: frames.length,
        attemptId: id,
        stream,
        observedBytes: bytes.length,
        retainedBytes: bytes.length,
        base64: bytes.toString("base64"),
        sha256: hash(bytes),
      });
    }
    frames.push({
      type: "terminal",
      journalId: h.journalId,
      sequence: frames.length,
      attemptId: id,
      state: "exited",
      exitCode: code,
      signal: null,
      errorCode: null,
    });
  }
  frames.push({
    type: "journal-end",
    journalId: h.journalId,
    sequence: frames.length,
    admitted: 2,
    terminal: 2,
  });
  return { frames, ids, binaries };
}
test("native journal replay retains two actual binary child outputs and distinct successful and failed exit observations", () => {
  const h = header(),
    { frames, ids, binaries } = observations(h);
  const value = replayNativeAttemptFrames(h, frames, h);
  assert.equal(value.claimsVerified, false);
  assert.equal(value.completeForRecordedCalls, true);
  assert.equal(value.observedBytes, 12);
  assert.equal(value.retainedBytes, 12);
  assert.deepEqual(
    value.attempts.map((a) => a.id),
    ids,
  );
  assert.deepEqual(
    value.attempts.map((a) => a.exitCode),
    [0, 1],
  );
  for (const [i, call] of value.attempts.entries()) {
    assert.equal(call.capturedOutput.completeForObservedStreams, true);
    assert.deepEqual(
      Buffer.from(call.capturedOutput.stdout.base64, "base64"),
      binaries[i * 2],
    );
    assert.deepEqual(
      Buffer.from(call.capturedOutput.stderr.base64, "base64"),
      binaries[i * 2 + 1],
    );
  }
});
test("native journal omitted and unconfirmed interrupted calls remain incomplete without invented successful terminals", () => {
  const h = header(),
    { frames } = observations(h);
  const first = replayNativeAttemptFrames(h, frames.slice(0, 4), h);
  assert.equal(first.completeForRecordedCalls, false);
  assert.equal(first.attempts[0]!.state, "interrupted");
  assert.equal(first.attempts[0]!.exitCode, null);
  assert.equal(
    first.attempts[0]!.capturedOutput.completeForObservedStreams,
    false,
  );
  const admitted = replayNativeAttemptFrames(h, frames.slice(0, 1), h);
  assert.equal(admitted.attempts[0]!.state, "admitted-unconfirmed");
  assert.equal(admitted.attempts[0]!.pid, null);
  assert.equal(admitted.completeForRecordedCalls, false);
  const empty = replayNativeAttemptFrames(
    h,
    [
      {
        type: "journal-end",
        journalId: h.journalId,
        sequence: 0,
        admitted: 0,
        terminal: 0,
      },
    ],
    h,
  );
  assert.equal(empty.completeForRecordedCalls, false);
  assert.deepEqual(empty.attempts, []);
});
test("native journal physical hashes ordering identities counts lifecycle and source/operator limits reject independent contradictions", () => {
  const h = header(),
    { frames } = observations(h);
  const changes: Array<(f: NativeAttemptFrame[]) => void> = [
    (f) => {
      (f[2] as Extract<NativeAttemptFrame, { type: "output" }>).sha256 =
        "0".repeat(64);
    },
    (f) => {
      (f[2] as Extract<NativeAttemptFrame, { type: "output" }>).base64 = "AA==";
    },
    (f) => {
      f[2]!.sequence++;
    },
    (f) => {
      f[2]!.journalId = randomUUID();
    },
    (f) => {
      (f[2] as Extract<NativeAttemptFrame, { type: "output" }>).attemptId =
        randomUUID();
    },
    (f) => {
      (
        f.at(-1) as Extract<NativeAttemptFrame, { type: "journal-end" }>
      ).terminal = 1;
    },
    (f) => {
      f[5] = { ...f[0]!, sequence: 5 };
    },
    (f) => {
      f[3] = { ...f[1]!, sequence: 3 };
    },
    (f) => {
      f.push({ ...f[1]!, sequence: f.length });
    },
    (f) => {
      (f[4] as Extract<NativeAttemptFrame, { type: "terminal" }>).signal =
        "SIGKILL";
    },
    (f) => {
      (f[2] as Extract<NativeAttemptFrame, { type: "output" }>).observedBytes =
        5;
    },
    (f) => {
      (
        f.at(-1) as Extract<NativeAttemptFrame, { type: "journal-end" }>
      ).admitted = 1;
    },
  ];
  for (const change of changes) {
    const f = structuredClone(frames);
    change(f);
    assert.throws(() => replayNativeAttemptFrames(h, f, h), /journal/);
  }
  for (const field of [
    "journalId",
    "sourceFingerprint",
    "outerCommandSha256",
    "maxNativeCalls",
    "maxOutputBytes",
  ] as const) {
    const changed = {
      ...h,
      [field]:
        field === "journalId"
          ? randomUUID()
          : typeof h[field] === "number"
            ? (h[field] as number) + 1
            : "0".repeat(64),
    };
    assert.throws(
      () => replayNativeAttemptFrames(changed, frames, h),
      /binding/,
    );
  }
  const oneCall = { ...h, maxNativeCalls: 1 };
  assert.throws(
    () => replayNativeAttemptFrames(oneCall, frames, oneCall),
    /excessive attempt admission/,
    "The operator call limit applies even when the header binding is valid",
  );
  assert.equal(
    replayNativeAttemptFrames(h, frames, h).completeForRecordedCalls,
    true,
  );
});
test("native journal exact zero and overrun shared prefixes cannot become complete or resume retained bytes", () => {
  for (const maximum of [0, 5, 12]) {
    const h = header(maximum),
      { frames } = observations(header());
    let available = maximum;
    for (const f of frames) {
      f.journalId = h.journalId;
      if (f.type === "output") {
        const keep = Math.min(f.retainedBytes, available),
          b = Buffer.from(f.base64, "base64").subarray(0, keep);
        available -= keep;
        f.retainedBytes = keep;
        f.base64 = b.toString("base64");
        f.sha256 = hash(b);
      }
    }
    for (const f of frames)
      if (f.type === "terminal" && maximum < 12) {
        f.state = "output-limit";
        f.errorCode = "NATIVE_OUTPUT_LIMIT";
      }
    const v = replayNativeAttemptFrames(h, frames, h);
    assert.equal(v.retainedBytes, maximum);
    assert.equal(v.observedBytes, 12);
    assert.equal(v.completeForRecordedCalls, maximum === 12);
  }
});

test("native journal error causes and concurrent process acknowledgements reject contradictions while sequential PID reuse and observed transport errors remain distinct", () => {
  const h = header(),
    { frames } = observations(h);
  for (const state of ["output-limit", "transport-error"] as const) {
    const changed = structuredClone(frames),
      terminal = changed[4] as Extract<
        NativeAttemptFrame,
        { type: "terminal" }
      >;
    terminal.state = state;
    terminal.errorCode =
      state === "output-limit" ? "NATIVE_OUTPUT_LIMIT" : null;
    assert.throws(
      () => replayNativeAttemptFrames(h, changed, h),
      /terminal state/,
    );
  }
  const transport = structuredClone(frames),
    terminal = transport[4] as Extract<
      NativeAttemptFrame,
      { type: "terminal" }
    >;
  terminal.state = "transport-error";
  terminal.errorCode = "NATIVE_TRANSPORT_ERROR";
  const observed = replayNativeAttemptFrames(h, transport, h);
  assert.equal(observed.completeForRecordedCalls, false);
  assert.equal(observed.attempts[0]!.errorCode, "NATIVE_TRANSPORT_ERROR");
  assert.equal(
    observed.attempts[0]!.capturedOutput.completeForObservedStreams,
    false,
  );
  assert.equal(observed.attempts[0]!.capturedOutput.observedBytes, 6);
  const reused = structuredClone(frames);
  (reused[6] as Extract<NativeAttemptFrame, { type: "started" }>).pid = (
    frames[1] as Extract<NativeAttemptFrame, { type: "started" }>
  ).pid;
  assert.equal(
    replayNativeAttemptFrames(h, reused, h).completeForRecordedCalls,
    true,
    "A later sequential call can reuse a PID without proving authenticity",
  );
  const concurrent = [frames[0]!, frames[1]!, frames[5]!, frames[6]!].map(
    (f, sequence) => ({ ...f, sequence }),
  );
  assert.equal(
    replayNativeAttemptFrames(h, concurrent, h).completeForRecordedCalls,
    false,
  );
  (concurrent[3] as Extract<NativeAttemptFrame, { type: "started" }>).pid = (
    frames[1] as Extract<NativeAttemptFrame, { type: "started" }>
  ).pid;
  assert.throws(
    () => replayNativeAttemptFrames(h, concurrent, h),
    /concurrent attempts/,
  );
});
