import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { nativeJournalHeaderSchema } from "./native-attempt-frames.js";
import {
  captureNativeJournal,
  type NativeJournalCapture,
} from "./native-journal-capture.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const data = z.strictObject({
  bytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024),
  base64: z.string().max(4 * Math.ceil((8 * 1024 * 1024) / 3)),
  sha256: digest,
});
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const nativeJournalCaptureSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    format: z.literal("native-attempt-capture"),
    header: nativeJournalHeaderSchema,
    headerData: data,
    framesData: data,
    state: z.enum(["complete", "incomplete", "invalid"]),
    replayedPrefixBytes: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024),
    replay: z.unknown().optional(),
    errorCode: z
      .enum([
        "NATIVE_JOURNAL_HEADER_CHANGED",
        "NATIVE_JOURNAL_PARTIAL_FRAME",
        "NATIVE_JOURNAL_INVALID_FRAME",
      ])
      .optional(),
  })
  .superRefine((value, ctx) => {
    const h = Buffer.from(value.headerData.base64, "base64"),
      f = Buffer.from(value.framesData.base64, "base64");
    if (
      h.length > 4096 ||
      h.length !== value.headerData.bytes ||
      f.length !== value.framesData.bytes ||
      h.toString("base64") !== value.headerData.base64 ||
      f.toString("base64") !== value.framesData.base64 ||
      hash(h) !== value.headerData.sha256 ||
      hash(f) !== value.framesData.sha256
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Native capture physical bytes differ",
      });
      return;
    }
    const expected = captureNativeJournal(
      value.header,
      h,
      f,
      hash(JSON.stringify(value.header) + "\n"),
    );
    if (!isDeepStrictEqual(value, expected))
      ctx.addIssue({
        code: "custom",
        message: "Native capture replay differs from its physical buffers",
      });
  });
export const engineNativeJournalSchema = z
  .strictObject({
    expectedHeader: nativeJournalHeaderSchema,
    producer: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9-]*$/),
      beforeSha256: digest,
      afterSha256: digest.nullable(),
    }),
    status: z.enum(["collected", "unavailable"]),
    capture: nativeJournalCaptureSchema.optional(),
    errorCode: z
      .enum([
        "NATIVE_JOURNAL_STORAGE_UNAVAILABLE",
        "NATIVE_JOURNAL_PRODUCER_CHANGED",
      ])
      .optional(),
    cleanupErrorCode: z
      .literal("NATIVE_JOURNAL_CLEANUP_UNAVAILABLE")
      .optional(),
  })
  .superRefine((value, ctx) => {
    const storageUnavailable = value.status === "unavailable";
    const producerChanged =
      value.status === "collected" &&
      value.producer.beforeSha256 !== value.producer.afterSha256;
    if (
      storageUnavailable !==
        (value.errorCode === "NATIVE_JOURNAL_STORAGE_UNAVAILABLE") ||
      producerChanged !==
        (value.errorCode === "NATIVE_JOURNAL_PRODUCER_CHANGED") ||
      (storageUnavailable && value.producer.afterSha256 !== null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Native journal producer or collection error differs from its state",
      });
    if (
      (value.status === "collected") !== Boolean(value.capture) ||
      (value.capture &&
        !isDeepStrictEqual(
          value.expectedHeader,
          (value.capture as NativeJournalCapture).header,
        ))
    )
      ctx.addIssue({
        code: "custom",
        message: "Native journal collection or expected header differs",
      });
  });
