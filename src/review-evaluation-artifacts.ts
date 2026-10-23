import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type BigIntStats,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  openSync,
  readSync,
  realpathSync,
  opendirSync,
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
import {
  ensureWindowsTaskAccess,
  ensureWindowsTaskAccessBatch,
} from "./windows-task-access.js";
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
/** Initialize a new outside-project namespace; existing objects are never repaired. */
export function initializeReviewEvaluationStorage(
  projectRoot: string,
  storageRoot: string,
) {
  if (!path.isAbsolute(storageRoot))
    throw Error("Capture storage requires an absolute directory");
  const parent = canonicalDirectory(path.dirname(storageRoot));
  const root = path.join(parent, path.basename(storageRoot));
  const relative = path.relative(realpathSync(projectRoot), root);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  )
    throw Error("Capture storage must be outside the project");
  mkdirSync(root, { mode: 0o700 });
  const owned = lstatSync(root, { bigint: true });
  let child: BigIntStats | undefined;
  const blobs = path.join(root, "blobs");
  try {
    if (process.platform === "win32")
      ensureWindowsTaskAccess(root, "directory", true);
    mkdirSync(blobs, { mode: 0o700 });
    child = lstatSync(blobs, { bigint: true });
    if (process.platform === "win32")
      ensureWindowsTaskAccess(blobs, "directory", true);
    withEvaluationPrivateStorage(() => storage(projectRoot, root));
  } catch (error) {
    // Only remove our own still-empty inodes. Preserve anything replaced/populated
    // concurrently rather than recursively deleting an operator's namespace.
    const sameObject = (a: BigIntStats, b: BigIntStats) =>
      a.dev === b.dev && a.ino === b.ino && !b.isSymbolicLink();
    try {
      if (child && sameObject(child, lstatSync(blobs, { bigint: true })))
        rmdirSync(blobs);
    } catch {
      /* Preserve nonempty/replaced objects. */
    }
    try {
      if (sameObject(owned, lstatSync(root, { bigint: true }))) rmdirSync(root);
    } catch {
      /* Preserve nonempty/replaced objects. */
    }
    throw error;
  }
  return {
    schemaVersion: 1 as const,
    profile: "private-review-evaluation-storage-v1" as const,
    backend:
      process.platform === "win32"
        ? ("windows-dacl" as const)
        : ("posix-mode" as const),
    initialized: true as const,
    inferenceInvoked: false as const,
  };
}
// Permission observations live only for one synchronous operator call. Nested
// judging/matching replay shares them; no later invocation trusts this cache.
let privateOperation: Map<string, BigIntStats> | undefined;
let incomingOperation = false;
export function withEvaluationPrivateStorage<T>(
  operation: () => T,
  incoming = false,
): T {
  if (privateOperation) {
    if (incoming && !incomingOperation)
      throw Error("Nested private operation cannot widen incoming access");
    return operation();
  }
  incomingOperation = incoming;
  privateOperation = new Map();
  try {
    return operation();
  } finally {
    privateOperation = undefined;
    incomingOperation = false;
  }
}
const pathKey = (filename: string) => filename.toLowerCase();
function sameMetadata(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function canonicalDirectory(filename: string) {
  if (!path.isAbsolute(filename))
    throw Error("Capture storage requires a private absolute directory");
  const stat = lstatSync(filename);
  const canonical = realpathSync(filename);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform === "win32" &&
      (canonical.toLowerCase() !== path.normalize(filename).toLowerCase() ||
        !/^[A-Za-z]:\\/.test(canonical)))
  )
    throw Error(
      "Capture private storage rejects linked or mistyped directories",
    );
  return canonical;
}
function directory(filename: string) {
  const target = canonicalDirectory(filename);
  if (process.platform === "win32") {
    const checked = privateOperation?.get(pathKey(target));
    if (!checked || !sameMetadata(checked, lstatSync(target, { bigint: true })))
      throw Error(
        "Capture storage directory lacks a current private ACL observation",
      );
  } else {
    const stat = lstatSync(target);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
      throw Error(
        "Capture storage directory is not private operator-owned storage",
      );
  }
  return target;
}
function inspectWindowsRoot(root: string) {
  if (!privateOperation)
    throw Error("Private storage requires an operator operation");
  if (privateOperation.has(pathKey(root))) return;
  const entries = new Map<string, BigIntStats>();
  const targets: { filename: string; kind: "file" | "directory" }[] = [];
  const visit = (filename: string, depth: number) => {
    if (depth > 8 || entries.size >= 8192)
      throw Error("Private Windows storage inventory exceeds bound");
    const stat = lstatSync(filename, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1n) ||
      realpathSync(filename).toLowerCase() !== filename.toLowerCase()
    )
      throw Error(
        "Capture artifact is not a private singly linked regular file or directory",
      );
    const key = pathKey(filename);
    if (entries.has(key))
      throw Error("Private Windows storage has duplicate paths");
    entries.set(key, stat);
    targets.push({ filename, kind: stat.isDirectory() ? "directory" : "file" });
    if (stat.isDirectory()) {
      const stream = opendirSync(filename);
      try {
        for (let next = stream.readSync(); next; next = stream.readSync()) {
          if (depth === 0 && next.name === "blobs" && !incomingOperation)
            continue;
          visit(path.join(filename, next.name), depth + 1);
        }
      } finally {
        stream.closeSync();
      }
    }
  };
  visit(root, 0);
  ensureWindowsTaskAccessBatch(targets);
  for (const target of targets) {
    const key = pathKey(target.filename),
      before = entries.get(key)!;
    if (!sameMetadata(before, lstatSync(target.filename, { bigint: true })))
      throw Error("Private Windows storage changed during ACL inspection");
    privateOperation.set(key, before);
  }
}
function storage(project: string, root: string) {
  const target = canonicalDirectory(root),
    relative = path.relative(realpathSync(project), target);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  )
    throw Error("Capture storage must be outside the project");
  if (process.platform === "win32") inspectWindowsRoot(target);
  return directory(target);
}
function readPrivate(filename: string, limit: number) {
  const fd = openSync(
    filename,
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    const checked = privateOperation?.get(pathKey(filename));
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      (process.platform === "win32"
        ? !checked || !sameMetadata(checked, before)
        : before.uid !== BigInt(process.getuid!()) ||
          (before.mode & 0o777n) !== 0o600n)
    )
      throw Error(
        "Capture artifact is not a bounded private singly linked file",
      );
    const bytes = Buffer.alloc(Number(before.size));
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, at);
      if (!n) throw Error("Capture artifact ended early");
      at += n;
    }
    const after = fstatSync(fd, { bigint: true }),
      linked = lstatSync(filename, { bigint: true });
    if (
      !sameMetadata(before, after) ||
      !sameMetadata(after, linked) ||
      linked.isSymbolicLink()
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
    if (process.platform === "win32")
      ensureWindowsTaskAccess(pending, "file", true);
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
  if (process.platform === "win32") {
    if (!privateOperation)
      throw Error("Private storage requires an operator operation");
    privateOperation.set(
      pathKey(filename),
      lstatSync(filename, { bigint: true }),
    );
    privateOperation.set(pathKey(parent), lstatSync(parent, { bigint: true }));
    // Node cannot fsync a Windows directory handle. The file is flushed and the
    // hard-link publication is exclusive; power-loss directory durability is not claimed.
    return;
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
  return withEvaluationPrivateStorage(() => {
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
  }, true);
}
/** Replay uses retained bytes only. Editing/deleting the original incoming blob files cannot rewrite a sealed result. */
export function loadSealedReviewEvaluationCaptureArchive(
  projectRoot: string,
  storageRoot: string,
  expectedArchiveSha256: string,
) {
  return withEvaluationPrivateStorage(() => {
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
    return {
      input: archive.input,
      records,
      report: { ...result.report, archiveSha256: sha(bytes) },
    };
  });
}
export function inspectSealedReviewEvaluationCaptures(
  projectRoot: string,
  storageRoot: string,
  expectedArchiveSha256: string,
) {
  return withEvaluationPrivateStorage(() => {
    return loadSealedReviewEvaluationCaptureArchive(
      projectRoot,
      storageRoot,
      expectedArchiveSha256,
    ).report;
  });
}
/** Internal operator storage primitives; not exported from the package root. */
export const evaluationPrivateArtifacts = {
  storage,
  readPrivate,
  writeNew,
  decode,
  sha,
};
export type ReviewEvaluationSealedCaptureReport = ReturnType<
  typeof sealReviewEvaluationCaptures
>;
