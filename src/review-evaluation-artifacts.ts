import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  reviewEvaluationCaptureInputSchema,
  inspectReviewEvaluationCaptures,
  reviewEvaluationCaptureAssignments,
  type ReviewEvaluationCaptureInput,
} from "./review-evaluation-captures.js";
const MAX_BLOB = 4 * 1048576,
  MAX_RECORD = 1048576,
  MAX_TOTAL = 16 * 1048576,
  MAX_ARCHIVE = 32 * 1048576,
  MAX_FILES = 8192;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export function encodeReviewEvaluationArtifact(value: unknown) {
  return Buffer.from(JSON.stringify(value) + "\n");
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const descriptor = z.strictObject({
  sha256: digest,
  bytes: z.number().int().min(0).max(MAX_BLOB),
});
const rawStream = z.strictObject({
  retained: descriptor,
  observedBytes: z.number().int().min(0).max(1_000_000_000).nullable(),
  truncated: z.boolean(),
});
const meterSlot =
  reviewEvaluationCaptureInputSchema.shape.metering.shape.slots.element;
const attemptSchema = meterSlot.shape.attempts.element
  .omit({ recordSha256: true })
  .extend({
    schemaVersion: z.literal(1),
    profile: z.literal("external-review-attempt-artifact-v1"),
    assignmentSha256: digest,
    stdout: rawStream,
    stderr: rawStream,
  });
const captureRecordSchema =
  reviewEvaluationCaptureInputSchema.shape.captures.element
    .omit({ captureSha256: true })
    .extend({
      schemaVersion: z.literal(1),
      profile: z.literal("external-review-capture-artifact-v1"),
    });
export const reviewEvaluationAttemptArtifactSchema = attemptSchema;
export const reviewEvaluationCaptureArtifactSchema = captureRecordSchema;
const snapshot = z.strictObject({
  sha256: digest,
  base64: z.string().max(Math.ceil(MAX_BLOB / 3) * 4),
});
const archiveSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("sealed-external-review-captures-v1"),
  input: reviewEvaluationCaptureInputSchema,
  blobs: z.array(snapshot).max(MAX_FILES),
  missing: z.array(digest).max(MAX_FILES),
});
type Archive = z.infer<typeof archiveSchema>;
function directory(filename: string) {
  if (process.platform === "win32" || !path.isAbsolute(filename))
    throw Error("Capture storage requires a private absolute POSIX directory");
  const stat = lstatSync(filename);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error(
      "Capture storage directory is not private operator-owned storage",
    );
  return realpathSync(filename);
}
function storage(project: string, root: string) {
  const target = directory(root),
    relative = path.relative(realpathSync(project), target);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  )
    throw Error("Capture storage must be outside the project");
  return target;
}
function readPrivate(filename: string, limit: number) {
  const fd = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > limit
    )
      throw Error(
        "Capture artifact is not a bounded private singly linked file",
      );
    const bytes = Buffer.alloc(before.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw Error("Capture artifact ended early");
      at += n;
    }
    const after = fstatSync(fd),
      linked = lstatSync(filename);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== linked.dev ||
      after.ino !== linked.ino
    )
      throw Error("Capture artifact changed during reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function decode(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text)))
    throw Error("Capture artifact is not UTF-8");
  return JSON.parse(text) as unknown;
}
function writeNew(filename: string, bytes: Buffer) {
  if (bytes.length > MAX_ARCHIVE)
    throw Error("Capture archive exceeds byte bound");
  const parent = directory(path.dirname(filename)),
    pending = path.join(parent, ".pending-" + randomUUID());
  let fd: number | undefined;
  try {
    fd = openSync(
      pending,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    let at = 0;
    while (at < bytes.length) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (!n) throw Error("Capture write made no progress");
      at += n;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(pending, filename);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(pending)) unlinkSync(pending);
  }
  const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
const key = (r: { caseId: string; repetition: number; role: string }) =>
  JSON.stringify([r.caseId, r.repetition, r.role]);
function evaluate(
  input: ReviewEvaluationCaptureInput,
  load: (digest: string, max: number) => Buffer | null,
) {
  const metadata = inspectReviewEvaluationCaptures(input),
    issues = new Set<string>();
  const records = new Map<string, Buffer>(),
    missing = new Set<string>();
  let physicalBytes = 0;
  const get = (id: string, max: number) => {
    if (records.has(id)) {
      const b = records.get(id)!;
      if (b.length > max) throw Error("Capture artifact exceeds kind bound");
      return b;
    }
    if (missing.has(id)) return null;
    if (records.size + missing.size >= MAX_FILES)
      throw Error("Capture artifact count exceeds bound");
    const b = load(id, Math.min(max, MAX_TOTAL - physicalBytes));
    if (!b) {
      missing.add(id);
      issues.add("missing-physical-artifact");
      return null;
    }
    if (b.length > max || physicalBytes + b.length > MAX_TOTAL || sha(b) !== id)
      throw Error("Capture artifact bytes disagree with digest or bounds");
    records.set(id, b);
    physicalBytes += b.length;
    return b;
  };
  const assignments = new Map(
    reviewEvaluationCaptureAssignments(input.declaration).map((a) => [
      key(a),
      a,
    ]),
  );
  const observed = (s: z.infer<typeof rawStream>) => {
    const b = get(s.retained.sha256, MAX_BLOB);
    if (b && b.length !== s.retained.bytes) issues.add("stream-retention-size");
    if (
      s.observedBytes !== null &&
      (s.observedBytes < s.retained.bytes ||
        (!s.truncated && s.observedBytes !== s.retained.bytes))
    )
      issues.add("stream-observation-accounting");
    if (s.truncated) issues.add("truncated-physical-output");
    if (s.observedBytes === null) issues.add("unknown-physical-output");
    return s.observedBytes;
  };
  let validCaptureRecords = 0,
    validAttemptRecords = 0;
  for (const c of input.captures) {
    const bytes = get(c.captureSha256, MAX_RECORD);
    if (bytes) {
      try {
        const parsed = captureRecordSchema.parse(decode(bytes));
        const { captureSha256: _, ...expected } = c;
        void _;
        if (
          !isDeepStrictEqual(parsed, {
            schemaVersion: 1,
            profile: "external-review-capture-artifact-v1",
            ...expected,
          })
        )
          issues.add("capture-record-metadata");
        else validCaptureRecords++;
      } catch {
        issues.add("invalid-capture-record");
      }
    }
    if (c.output) {
      const b = get(c.output.sha256, MAX_BLOB);
      if (b && b.length !== c.output.bytes) issues.add("review-output-size");
    }
  }
  for (const m of input.metering.slots) {
    const a = assignments.get(key(m));
    for (const attempt of m.attempts) {
      const bytes = get(attempt.recordSha256, MAX_RECORD);
      if (!bytes) continue;
      try {
        const parsed = attemptSchema.parse(decode(bytes));
        const { recordSha256: _, ...expected } = attempt;
        void _;
        const { stdout, stderr, ...record } = parsed;
        if (
          !a ||
          !isDeepStrictEqual(record, {
            schemaVersion: 1,
            profile: "external-review-attempt-artifact-v1",
            assignmentSha256: a.assignmentSha256,
            ...expected,
          })
        ) {
          issues.add("attempt-record-metadata");
          continue;
        }
        const out = observed(stdout),
          err = observed(stderr);
        if (
          out !== null &&
          err !== null &&
          attempt.outputBytes !== null &&
          out + err !== attempt.outputBytes
        )
          issues.add("attempt-output-accounting");
        validAttemptRecords++;
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError)
          issues.add("invalid-attempt-record");
        else throw error;
      }
    }
  }
  // Captures and attempts are enumerated separately: an omitted capture cannot erase reached attempts.
  const report = {
    schemaVersion: 1 as const,
    profile: "sealed-external-review-captures-v1" as const,
    inputSha256: metadata.inputSha256,
    protocolSha256: metadata.protocolSha256,
    captureInventoryComplete: metadata.captureInventoryComplete,
    declaredOutputsComplete: metadata.declaredOutputsComplete,
    measurementAccountingComplete: metadata.measurementAccountingComplete,
    physicalArtifactsVerified:
      issues.size === 0 &&
      validCaptureRecords === input.captures.length &&
      validAttemptRecords ===
        input.metering.slots.reduce((n, m) => n + m.attempts.length, 0),
    plannedSlots: metadata.counts.plannedSlots,
    retainedCaptureRecords: validCaptureRecords,
    retainedAttemptRecords: validAttemptRecords,
    physicalBlobCount: records.size,
    missingBlobCount: missing.size,
    physicalBytes,
    issues: [...issues].sort(),
    collectorAuthenticityVerified: false as const,
    actualAttemptsComplete: false as const,
    hostIndependenceVerified: false as const,
    claimTruthVerified: false as const,
    qualityAssessed: false as const,
    gateAClosed: false as const,
    sourceIncluded: false as const,
    privateIdentitiesIncluded: false as const,
    inferenceInvoked: false as const,
  };
  return { report, records, missing };
}
/** Operator intake of externally produced files; never invokes a reviewer or opens case source/answers. */
export function sealReviewEvaluationCaptures(
  projectRoot: string,
  storageRoot: string,
  value: unknown,
) {
  const root = storage(projectRoot, storageRoot);
  const blobRoot = directory(path.join(root, "blobs"));
  const input = reviewEvaluationCaptureInputSchema.parse(value);
  const loaded = evaluate(input, (id, max) => {
    try {
      return readPrivate(path.join(blobRoot, id + ".blob"), max);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  const archive: Archive = {
    schemaVersion: 1,
    profile: "sealed-external-review-captures-v1",
    input,
    blobs: [...loaded.records]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([sha256, b]) => ({ sha256, base64: b.toString("base64") })),
    missing: [...loaded.missing].sort(),
  };
  const bytes = encodeReviewEvaluationArtifact(archive);
  const file = path.join(root, "captures.sealed.json");
  writeNew(file, bytes);
  return { ...loaded.report, archiveSha256: sha(bytes) };
}
/** Replay uses retained bytes only. Editing/deleting the original incoming blob files cannot rewrite a sealed result. */
export function inspectSealedReviewEvaluationCaptures(
  projectRoot: string,
  storageRoot: string,
  expectedArchiveSha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    bytes = readPrivate(path.join(root, "captures.sealed.json"), MAX_ARCHIVE);
  if (sha(bytes) !== digest.parse(expectedArchiveSha256))
    throw Error("Sealed capture archive identity changed");
  const archive = archiveSchema.parse(decode(bytes));
  const records = new Map<string, Buffer>();
  for (const row of archive.blobs) {
    if (records.has(row.sha256)) throw Error("Duplicate sealed capture blob");
    const b = Buffer.from(row.base64, "base64");
    if (b.toString("base64") !== row.base64 || sha(b) !== row.sha256)
      throw Error("Sealed capture blob changed");
    records.set(row.sha256, b);
  }
  const absent = new Set(archive.missing);
  if (
    absent.size !== archive.missing.length ||
    [...absent].some((k) => records.has(k))
  )
    throw Error("Invalid sealed missing inventory");
  const result = evaluate(archive.input, (id, max) => {
    const b = records.get(id);
    if (b && b.length > max) throw Error("Sealed capture blob exceeds bound");
    return b ?? null;
  });
  if (
    records.size !== result.records.size ||
    !isDeepStrictEqual([...absent].sort(), [...result.missing].sort())
  )
    throw Error("Sealed physical artifact inventory disagrees");
  return { ...result.report, archiveSha256: sha(bytes) };
}
export type ReviewEvaluationSealedCaptureReport = ReturnType<
  typeof sealReviewEvaluationCaptures
>;
