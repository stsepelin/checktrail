import { createHash } from "node:crypto";
import { z } from "zod";
const maximum = 16 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const blob = z.strictObject({
  base64: z
    .string()
    .max(4 * Math.ceil(maximum / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  bytes: z.number().int().min(0).max(maximum),
  sha256: digest,
});
export const capturedProcessOutputSchema = z.strictObject({
  profile: z.literal("bounded-physical-process-output-v1"),
  stdout: blob,
  stderr: blob,
  observedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completeForObservedStreams: z.boolean(),
});
export type CapturedProcessOutput = z.infer<typeof capturedProcessOutputSchema>;
const hash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");
export function captureProcessOutput(
  stdout: Buffer,
  stderr: Buffer,
  observedBytes: number,
  completeForObservedStreams: boolean,
): CapturedProcessOutput {
  const encode = (buffer: Buffer) => ({
    base64: buffer.toString("base64"),
    bytes: buffer.length,
    sha256: hash(buffer),
  });
  return parseCapturedProcessOutput({
    profile: "bounded-physical-process-output-v1",
    stdout: encode(stdout),
    stderr: encode(stderr),
    observedBytes,
    completeForObservedStreams,
  });
}
export function parseCapturedProcessOutput(
  input: unknown,
): CapturedProcessOutput {
  const captured = capturedProcessOutputSchema.parse(input);
  const retained = captured.stdout.bytes + captured.stderr.bytes;
  if (
    retained > maximum ||
    retained > captured.observedBytes ||
    (captured.completeForObservedStreams && retained !== captured.observedBytes)
  )
    throw new Error(
      "Captured physical process byte accounting does not reconcile",
    );
  for (const stream of [captured.stdout, captured.stderr]) {
    const bytes = Buffer.from(stream.base64, "base64");
    if (
      bytes.toString("base64") !== stream.base64 ||
      bytes.length !== stream.bytes ||
      hash(bytes) !== stream.sha256
    )
      throw new Error(
        "Captured physical process output bytes or digest disagree",
      );
  }
  return captured;
}
