import { createHash } from "node:crypto";
import { z } from "zod";
import { captureProcessOutput } from "./process-output.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().uuid();
export const nativeJournalHeaderSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("native-attempt-journal"),
  journalId: id,
  sourceFingerprint: digest,
  outerCommandSha256: digest,
  maxNativeCalls: z.number().int().min(1).max(4096),
  maxOutputBytes: z
    .number()
    .int()
    .min(0)
    .max(4 * 1024 * 1024),
});
const common = { journalId: id, sequence: count };
const attempt = { ...common, attemptId: id };
export const nativeAttemptFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...attempt,
    type: z.literal("admitted"),
    commandSha256: digest,
  }),
  z.strictObject({
    ...attempt,
    type: z.literal("started"),
    pid: z.number().int().min(2).max(0x7fffffff),
  }),
  z.strictObject({
    ...attempt,
    type: z.literal("output"),
    stream: z.enum(["stdout", "stderr"]),
    observedBytes: count,
    retainedBytes: z.number().int().min(0).max(65536),
    base64: z.string().max(4 * Math.ceil(65536 / 3)),
    sha256: digest,
  }),
  z.strictObject({
    ...attempt,
    type: z.literal("terminal"),
    state: z.enum(["exited", "spawn-error", "output-limit", "transport-error"]),
    exitCode: z.number().int().min(0).max(0x7fffffff).nullable(),
    signal: z
      .string()
      .regex(/^SIG[A-Z0-9]+$/)
      .max(24)
      .nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .max(64)
      .nullable(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("journal-end"),
    admitted: count,
    terminal: count,
  }),
]);
export type NativeJournalHeader = z.infer<typeof nativeJournalHeaderSchema>;
export type NativeAttemptFrame = z.infer<typeof nativeAttemptFrameSchema>;
export type NativeJournalBinding = Pick<
  NativeJournalHeader,
  | "journalId"
  | "sourceFingerprint"
  | "outerCommandSha256"
  | "maxNativeCalls"
  | "maxOutputBytes"
>;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
type Call = {
  id: string;
  commandSha256: string;
  pid: number | null;
  stdout: Buffer[];
  stderr: Buffer[];
  observedBytes: number;
  retainedBytes: number;
  truncated: boolean;
  terminal: Extract<NativeAttemptFrame, { type: "terminal" }> | null;
};
/** Replay observations only. Shape/hash consistency does not authenticate project execution. */
export function replayNativeAttemptFrames(
  headerInput: unknown,
  framesInput: unknown,
  binding: NativeJournalBinding,
) {
  const header = nativeJournalHeaderSchema.parse(headerInput);
  if (
    header.journalId !== binding.journalId ||
    header.sourceFingerprint !== binding.sourceFingerprint ||
    header.outerCommandSha256 !== binding.outerCommandSha256 ||
    header.maxNativeCalls !== binding.maxNativeCalls ||
    header.maxOutputBytes !== binding.maxOutputBytes
  )
    throw new Error(
      "Native journal source command or identity binding changed",
    );
  const frames = z
    .array(nativeAttemptFrameSchema)
    .max(65536)
    .parse(framesInput);
  const calls = new Map<string, Call>();
  let retained = 0,
    observed = 0,
    ended = false;
  for (const [sequence, frame] of frames.entries()) {
    if (
      ended ||
      frame.sequence !== sequence ||
      frame.journalId !== header.journalId
    )
      throw new Error(
        "Native journal order identity or terminal boundary disagrees",
      );
    if (frame.type === "journal-end") {
      if (
        frame.admitted !== calls.size ||
        frame.terminal !==
          [...calls.values()].filter((call) => call.terminal !== null).length
      )
        throw new Error("Native journal terminal counts do not reconcile");
      ended = true;
      continue;
    }
    if (frame.type === "admitted") {
      if (calls.has(frame.attemptId) || calls.size >= header.maxNativeCalls)
        throw new Error(
          "Native journal duplicate or excessive attempt admission",
        );
      calls.set(frame.attemptId, {
        id: frame.attemptId,
        commandSha256: frame.commandSha256,
        pid: null,
        stdout: [],
        stderr: [],
        observedBytes: 0,
        retainedBytes: 0,
        truncated: false,
        terminal: null,
      });
      continue;
    }
    const call = calls.get(frame.attemptId);
    if (!call || call.terminal !== null)
      throw new Error("Native journal attempt is missing or already terminal");
    if (frame.type === "started") {
      if (call.pid !== null)
        throw new Error("Native journal duplicate process acknowledgement");
      if (
        [...calls.values()].some(
          (other) =>
            other !== call &&
            other.pid === frame.pid &&
            other.terminal === null,
        )
      )
        throw new Error(
          "Native journal concurrent attempts share one process acknowledgement",
        );
      call.pid = frame.pid;
      continue;
    }
    if (frame.type === "output") {
      if (
        call.pid === null ||
        frame.observedBytes === 0 ||
        frame.retainedBytes > frame.observedBytes
      )
        throw new Error(
          "Native journal output lacks a reached process or valid byte counts",
        );
      const bytes = Buffer.from(frame.base64, "base64");
      if (
        bytes.toString("base64") !== frame.base64 ||
        bytes.length !== frame.retainedBytes ||
        hash(bytes) !== frame.sha256
      )
        throw new Error(
          "Native journal physical chunk bytes and digest disagree",
        );
      // Prefix capture cannot skip bytes while space remains or resume after a cut.
      const expected = Math.min(
        frame.observedBytes,
        Math.max(0, header.maxOutputBytes - retained),
      );
      if (
        frame.retainedBytes !== expected ||
        (call.truncated && frame.retainedBytes !== 0)
      )
        throw new Error(
          "Native journal output violates its shared prefix allowance",
        );
      retained += frame.retainedBytes;
      observed += frame.observedBytes;
      if (!Number.isSafeInteger(observed))
        throw new Error("Native journal observed bytes exceed safe accounting");
      call.observedBytes += frame.observedBytes;
      call.retainedBytes += frame.retainedBytes;
      call.truncated ||= frame.observedBytes !== frame.retainedBytes;
      call[frame.stream].push(bytes);
      continue;
    }
    if (frame.state === "spawn-error") {
      if (
        call.pid !== null ||
        call.observedBytes !== 0 ||
        frame.exitCode !== null ||
        frame.signal !== null ||
        frame.errorCode === null
      )
        throw new Error(
          "Native journal spawn failure contradicts process observations",
        );
    } else {
      if (
        call.pid === null ||
        (frame.exitCode !== null && frame.signal !== null) ||
        (frame.state === "exited" &&
          frame.exitCode === null &&
          frame.signal === null) ||
        (frame.state === "exited" && frame.errorCode !== null) ||
        (frame.state === "exited" && call.truncated) ||
        (frame.state === "output-limit" &&
          (!call.truncated || frame.errorCode === null)) ||
        (frame.state === "transport-error" && frame.errorCode === null)
      )
        throw new Error(
          "Native journal terminal state contradicts reached process observations",
        );
    }
    call.terminal = frame;
  }
  return {
    schemaVersion: 1 as const,
    format: "native-attempt-journal" as const,
    claimsVerified: false as const,
    header,
    framesSha256: hash(JSON.stringify(frames)),
    observedBytes: observed,
    retainedBytes: retained,
    completeForRecordedCalls:
      ended &&
      calls.size > 0 &&
      [...calls.values()].every(
        (call) =>
          call.terminal !== null &&
          call.terminal.state === "exited" &&
          !call.truncated,
      ),
    attempts: [...calls.values()].map((call) => ({
      id: call.id,
      commandSha256: call.commandSha256,
      pid: call.pid,
      state:
        call.terminal?.state ??
        (call.pid === null ? "admitted-unconfirmed" : "interrupted"),
      exitCode: call.terminal?.exitCode ?? null,
      signal: call.terminal?.signal ?? null,
      errorCode: call.terminal?.errorCode ?? null,
      capturedOutput: captureProcessOutput(
        Buffer.concat(call.stdout),
        Buffer.concat(call.stderr),
        call.observedBytes,
        call.terminal?.state === "exited" && !call.truncated,
      ),
    })),
  };
}
