import { createHash } from "node:crypto";
import {
  replayNativeAttemptFrames,
  type NativeJournalHeader,
} from "./native-attempt-frames.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export interface NativeJournalCapture {
  schemaVersion: 1;
  format: "native-attempt-capture";
  header: NativeJournalHeader;
  headerData: { bytes: number; base64: string; sha256: string };
  framesData: { bytes: number; base64: string; sha256: string };
  state: "complete" | "incomplete" | "invalid";
  replayedPrefixBytes: number;
  replay?: ReturnType<typeof replayNativeAttemptFrames>;
  errorCode?:
    | "NATIVE_JOURNAL_HEADER_CHANGED"
    | "NATIVE_JOURNAL_PARTIAL_FRAME"
    | "NATIVE_JOURNAL_INVALID_FRAME";
}
const data = (bytes: Buffer) => ({
  bytes: bytes.length,
  base64: bytes.toString("base64"),
  sha256: hash(bytes),
});
/** Preserve physical data even when strict replay cannot certify it. The caller
 * must have validated private file identity and collected after process cleanup.
 */
export function captureNativeJournal(
  header: NativeJournalHeader,
  headerBytes: Buffer,
  framesBytes: Buffer,
  expectedHeaderSha256: string,
): NativeJournalCapture {
  const capture: NativeJournalCapture = {
    schemaVersion: 1,
    format: "native-attempt-capture",
    header,
    headerData: data(headerBytes),
    framesData: data(framesBytes),
    state: "invalid",
    replayedPrefixBytes: 0,
  };
  if (hash(headerBytes) !== expectedHeaderSha256)
    return { ...capture, errorCode: "NATIVE_JOURNAL_HEADER_CHANGED" };
  const partial = framesBytes.length > 0 && framesBytes.at(-1) !== 10;
  const prefixBytes = partial
    ? framesBytes.subarray(0, framesBytes.lastIndexOf(10) + 1)
    : framesBytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(prefixBytes);
    const lines = text ? text.slice(0, -1).split("\n") : [];
    if (lines.some((line) => !line)) throw Error("Empty native journal frame");
    const replay = replayNativeAttemptFrames(
      header,
      lines.map((line) => JSON.parse(line) as unknown),
      header,
    );
    return {
      ...capture,
      state: partial
        ? "invalid"
        : replay.completeForRecordedCalls
          ? "complete"
          : "incomplete",
      replay,
      replayedPrefixBytes: prefixBytes.length,
      ...(partial
        ? { errorCode: "NATIVE_JOURNAL_PARTIAL_FRAME" as const }
        : {}),
    };
  } catch {
    return {
      ...capture,
      errorCode: partial
        ? "NATIVE_JOURNAL_PARTIAL_FRAME"
        : "NATIVE_JOURNAL_INVALID_FRAME",
    };
  }
}
