import { randomBytes } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import { reviewScoringObservationSchema } from "./review-scoring.js";
import { reviewEvaluationCaptureAssignments } from "./review-evaluation-captures.js";
import {
  encodeReviewEvaluationArtifact,
  loadSealedReviewEvaluationCaptureArchive,
  evaluationPrivateArtifacts as privateFiles,
} from "./review-evaluation-artifacts.js";
const { storage, readPrivate, writeNew, decode, sha } = privateFiles;
const MAX_FILE = 4 * 1048576,
  MAX_TOTAL = 16 * 1048576,
  MAX_BOOK = 32 * 1048576;
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  caseId = z.string().regex(/^case-[a-f0-9]{32}$/),
  blindId = z.string().regex(/^judge-[a-f0-9]{32}$/),
  claimId = z.string().regex(/^claim-[a-f0-9]{32}$/);
const canonicalPath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !/[\\\0:]/.test(p) &&
      !p.startsWith("/") &&
      p.split("/").every((x) => x && x !== "." && x !== ".."),
    "Noncanonical source path",
  );
const citation = z
  .strictObject({
    file: canonicalPath,
    startLine: z.number().int().min(1).max(1000000),
    endLine: z.number().int().min(1).max(1000000),
    quote: z.string().min(1).max(8192),
  })
  .refine((c) => c.startLine <= c.endLine, "Invalid citation range");
export const reviewEvaluationSourcePacketSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profile: z.literal("independent-review-source-packet-v1"),
    files: z
      .array(
        z.strictObject({
          file: canonicalPath,
          content: z.string().max(MAX_FILE),
        }),
      )
      .min(1)
      .max(256),
  })
  .superRefine((v, c) => {
    if (new Set(v.files.map((f) => f.file)).size !== v.files.length)
      c.addIssue({ code: "custom", message: "Duplicate source path" });
    if (
      v.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > MAX_FILE
    )
      c.addIssue({
        code: "custom",
        message: "Source packet exceeds byte bound",
      });
  });
/** The same structured-output contract is usable by an unassisted baseline host. */
export const reviewEvaluationReviewOutputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profile: z.literal("independent-review-output-v1"),
    claims: z
      .array(
        z.strictObject({
          id: claimId,
          family: reviewFamilySchema,
          statement: z.string().min(1).max(8192),
          citations: z.array(citation).min(1).max(16),
          probability: z.number().min(0).max(1).nullable(),
        }),
      )
      .max(32),
  })
  .superRefine((v, c) => {
    if (new Set(v.claims.map((x) => x.id)).size !== v.claims.length)
      c.addIssue({ code: "custom", message: "Duplicate review claim" });
  });
export const reviewEvaluationJudgmentResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("independent-review-judgment-v1"),
  packetSha256: digest,
  sessionId: z.string().regex(/^session-[a-f0-9]{32}$/),
  status: z.enum([
    "completed",
    "unavailable",
    "refused",
    "cancelled",
    "timed-out",
    "error",
    "incomplete",
  ]),
  claims: z
    .array(
      z.strictObject({
        id: claimId,
        judgement: reviewScoringObservationSchema.shape.judgement.exclude([
          "none",
        ]),
        citations: z.array(citation).max(16),
      }),
    )
    .max(32),
});
const bookSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("independent-external-review-judging-v1"),
  archiveSha256: digest,
  protocolSha256: digest,
  procedureSha256: digest,
  salt: digest,
  sources: z
    .array(
      z.strictObject({
        caseId,
        base64: z.string().max(Math.ceil(MAX_FILE / 3) * 4),
      }),
    )
    .max(256),
  slots: z
    .array(
      z.strictObject({
        caseId,
        repetition: z.number().int().min(0).max(1),
        role: z.enum(["baseline", "verifier", "reference"]),
        blindId,
      }),
    )
    .max(1536),
});
type Book = z.infer<typeof bookSchema>;
const submissionsSchema = z
  .array(z.strictObject({ blindId, responseSha256: digest.nullable() }))
  .max(1536);
const sealedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("sealed-independent-review-judgments-v1"),
  bookSha256: digest,
  submissions: submissionsSchema,
  responses: z
    .array(
      z.strictObject({
        sha256: digest,
        base64: z.string().max(Math.ceil(1048576 / 3) * 4),
      }),
    )
    .max(1536),
  missing: z.array(digest).max(1536),
});
const key = (r: { caseId: string; repetition: number; role: string }) =>
  JSON.stringify([r.caseId, r.repetition, r.role]);
function sourcePackets(
  book: Book,
  input: ReturnType<typeof loadSealedReviewEvaluationCaptureArchive>["input"],
) {
  const selected = input.declaration.cohort.cases.filter(
      (c) => c.disposition.status === "selected",
    ),
    expected = new Map(selected.map((c) => [c.id, c]));
  const packets = new Map<
    string,
    z.infer<typeof reviewEvaluationSourcePacketSchema>
  >();
  let total = 0;
  for (const row of book.sources) {
    if (!expected.has(row.caseId) || packets.has(row.caseId))
      throw Error("Judging source inventory disagrees");
    const bytes = Buffer.from(row.base64, "base64");
    if (
      bytes.toString("base64") !== row.base64 ||
      bytes.length > MAX_FILE ||
      (total += bytes.length) > MAX_TOTAL ||
      sha(bytes) !== expected.get(row.caseId)!.contentSha256
    )
      throw Error("Judging source packet identity or bounds disagree");
    packets.set(
      row.caseId,
      reviewEvaluationSourcePacketSchema.parse(decode(bytes)),
    );
  }
  if (packets.size !== expected.size)
    throw Error("Judging source inventory is incomplete");
  return packets;
}
function slotBook(
  input: ReturnType<typeof loadSealedReviewEvaluationCaptureArchive>["input"],
  salt: string,
) {
  return reviewEvaluationCaptureAssignments(input.declaration).map((a) => ({
    caseId: a.caseId,
    repetition: a.repetition,
    role: a.role,
    blindId:
      "judge-" +
      sha(encodeReviewEvaluationArtifact([salt, a.assignmentSha256])).slice(
        0,
        32,
      ),
  }));
}
function loadBook(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    bytes = readPrivate(path.join(root, "judging.book.json"), MAX_BOOK);
  if (sha(bytes) !== digest.parse(expectedBookSha256))
    throw Error("Judging book identity changed");
  const book = bookSchema.parse(decode(bytes)),
    captured = loadSealedReviewEvaluationCaptureArchive(
      projectRoot,
      storageRoot,
      book.archiveSha256,
    );
  if (
    book.protocolSha256 !== captured.report.protocolSha256 ||
    book.procedureSha256 !==
      captured.input.declaration.protocol.procedures
        .independentJudgmentSha256 ||
    !isDeepStrictEqual(book.slots, slotBook(captured.input, book.salt))
  )
    throw Error("Judging book bindings disagree");
  const sources = sourcePackets(book, captured.input);
  return { root, book, captured, sources };
}
function citationsCurrent(
  rows: z.infer<typeof citation>[],
  source: z.infer<typeof reviewEvaluationSourcePacketSchema>,
) {
  return rows.every((c) => {
    const f = source.files.find((f) => f.file === c.file);
    if (!f) return false;
    const lines = f.content.split("\n");
    return (
      c.endLine <= lines.length &&
      lines
        .slice(c.startLine - 1, c.endLine)
        .join("\n")
        .includes(c.quote)
    );
  });
}
function packetFor(loaded: ReturnType<typeof loadBook>, id: string) {
  const slot = loaded.book.slots.find((s) => s.blindId === id);
  if (!slot) throw Error("Unknown judging slot");
  const captures = loaded.captured.input.captures.filter(
    (c) => key(c) === key(slot),
  );
  const row = captures.length === 1 ? captures[0] : undefined;
  let review: z.infer<typeof reviewEvaluationReviewOutputSchema> | null = null;
  let status: "completed" | "missing" | "invalid" | "incomplete" = "missing";
  if (row) {
    status = row.status === "completed" ? "invalid" : "incomplete";
    const bytes = row.output
      ? loaded.captured.records.get(row.output.sha256)
      : undefined;
    if (row.status === "completed" && bytes) {
      try {
        review = reviewEvaluationReviewOutputSchema.parse(decode(bytes));
        if (
          !citationsCurrent(
            review.claims.flatMap((c) => c.citations),
            loaded.sources.get(slot.caseId)!,
          )
        ) {
          review = null;
        } else status = "completed";
      } catch {
        review = null;
      }
    }
  }
  const packet = {
    schemaVersion: 1 as const,
    profile: "anonymous-independent-review-judgment-packet-v1" as const,
    blindId: id,
    procedureSha256: loaded.book.procedureSha256,
    reviewStatus: status,
    source: loaded.sources.get(slot.caseId)!,
    claims:
      review?.claims.map(({ probability, ...c }) => {
        void probability;
        return c;
      }) ?? [],
    instructions:
      "Judge each submitted claim independently against this source. Return the exact claim IDs and source citations. Do not infer a clean review from an invalid or incomplete output. No peer reviews, prior judgments or answer labels are supplied.",
  };
  const packetSha256 = sha(encodeReviewEvaluationArtifact(packet));
  if (
    encodeReviewEvaluationArtifact({ ...packet, packetSha256 }).length >
    MAX_FILE
  )
    throw Error("Judging packet exceeds disclosure bound");
  return {
    slot,
    review,
    status,
    packet,
    packetSha256,
  };
}
/** Operator-only setup after physical collection; it never invokes a host. */
export function prepareReviewEvaluationJudging(
  projectRoot: string,
  storageRoot: string,
  expectedArchiveSha256: string,
  sources: unknown,
) {
  if (Array.isArray(sources) && sources.length > 256)
    throw Error("Judging source count bound exceeded");
  const root = storage(projectRoot, storageRoot),
    captured = loadSealedReviewEvaluationCaptureArchive(
      projectRoot,
      storageRoot,
      expectedArchiveSha256,
    );
  const book: Book = bookSchema.parse({
    schemaVersion: 1,
    profile: "independent-external-review-judging-v1",
    archiveSha256: expectedArchiveSha256,
    protocolSha256: captured.report.protocolSha256,
    procedureSha256:
      captured.input.declaration.protocol.procedures.independentJudgmentSha256,
    salt: randomBytes(32).toString("hex"),
    sources,
    slots: [],
  });
  book.slots = slotBook(captured.input, book.salt);
  const prepared = {
    root,
    book,
    captured,
    sources: sourcePackets(book, captured.input),
  };
  if (new Set(book.slots.map((s) => s.blindId)).size !== book.slots.length)
    throw Error("Judging slot identity collision");
  for (const slot of book.slots) packetFor(prepared, slot.blindId);
  const bytes = encodeReviewEvaluationArtifact(book);
  writeNew(path.join(root, "judging.book.json"), bytes);
  return {
    schemaVersion: 1 as const,
    bookSha256: sha(bytes),
    plannedJudgments: book.slots.length,
    blindIds: book.slots.map((s) => s.blindId),
    sourceIncluded: false as const,
    inferenceInvoked: false as const,
    gateAClosed: false as const,
  };
}
/** Deliberate source disclosure by the operator, outside CLI/MCP model arguments. */
export function reviewEvaluationJudgmentPacket(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
  id: string,
  allowSource: boolean,
) {
  if (allowSource !== true)
    throw Error("Judging source disclosure requires the operator grant");
  const loaded = loadBook(projectRoot, storageRoot, expectedBookSha256),
    p = packetFor(loaded, blindId.parse(id));
  return { ...p.packet, packetSha256: p.packetSha256 };
}
function judgeIntakes(
  loaded: ReturnType<typeof loadBook>,
  submissions: z.infer<typeof submissionsSchema>,
  load: (id: string) => Buffer | null,
) {
  const received = new Map<string, typeof submissions>();
  for (const s of submissions)
    received.set(s.blindId, [...(received.get(s.blindId) ?? []), s]);
  const responses = new Map<string, Buffer>(),
    missing = new Set<string>();
  let total = 0;
  const get = (id: string) => {
    if (responses.has(id)) return responses.get(id)!;
    if (missing.has(id)) return null;
    const bytes = load(id);
    if (!bytes) {
      missing.add(id);
      return null;
    }
    if (
      bytes.length > 1048576 ||
      sha(bytes) !== id ||
      (total += bytes.length) > MAX_TOTAL
    )
      throw Error("Judgment artifact identity or bound disagrees");
    responses.set(id, bytes);
    return bytes;
  };
  // Collect every supplied physical response, including duplicate and foreign records.
  const parsed = new Map<
    string,
    z.infer<typeof reviewEvaluationJudgmentResponseSchema>
  >();
  for (const s of submissions) {
    if (!s.responseSha256) continue;
    const bytes = get(s.responseSha256);
    if (!bytes) continue;
    try {
      parsed.set(
        s.responseSha256,
        reviewEvaluationJudgmentResponseSchema.parse(decode(bytes)),
      );
    } catch {
      /* malformed response remains retained */
    }
  }
  const sessions = new Map<string, number>();
  for (const s of submissions) {
    const p = s.responseSha256 ? parsed.get(s.responseSha256) : undefined;
    if (p) sessions.set(p.sessionId, (sessions.get(p.sessionId) ?? 0) + 1);
  }
  const reviewSessions = new Set(
    loaded.captured.input.metering.slots.flatMap((s) =>
      s.attempts.map((a) => a.sessionId),
    ),
  );
  const rows = loaded.book.slots.map((slot) => {
    const list = received.get(slot.blindId) ?? [];
    const p = packetFor(loaded, slot.blindId);
    let status:
      | "accepted"
      | "missing"
      | "duplicate"
      | "invalid"
      | "foreign"
      | "incomplete"
      | "session-reuse" = "missing";
    let response: z.infer<
      typeof reviewEvaluationJudgmentResponseSchema
    > | null = null;
    if (list.length > 1) status = "duplicate";
    else if (list.length === 1 && list[0]!.responseSha256) {
      response = parsed.get(list[0]!.responseSha256!) ?? null;
      status = "invalid";
      if (response) {
        if (
          sessions.get(response.sessionId)! > 1 ||
          reviewSessions.has(response.sessionId)
        )
          status = "session-reuse";
        else if (response.packetSha256 !== p.packetSha256) status = "foreign";
        else if (response.status !== "completed" || p.status !== "completed")
          status = "incomplete";
        else if (
          response.claims.length === p.packet.claims.length &&
          new Set(response.claims.map((c) => c.id)).size ===
            response.claims.length &&
          response.claims.every(
            (c) =>
              p.packet.claims.some((x) => x.id === c.id) &&
              citationsCurrent(c.citations, loaded.sources.get(slot.caseId)!) &&
              (c.judgement === "unresolved" || c.citations.length > 0),
          )
        )
          status = "accepted";
      }
    }
    return {
      blindId: slot.blindId,
      status,
      response,
      reviewStatus: p.status,
      retainedClaims: p.packet.claims.length,
    };
  });
  const expected = new Set(loaded.book.slots.map((s) => s.blindId));
  const counts = {
    planned: rows.length,
    accepted: rows.filter((r) => r.status === "accepted").length,
    missing: rows.filter((r) => r.status === "missing").length,
    rejected: rows.filter((r) => !["accepted", "missing"].includes(r.status))
      .length,
    supplied: submissions.length,
    receivedUniquePlanned: new Set(
      submissions.filter((s) => expected.has(s.blindId)).map((s) => s.blindId),
    ).size,
    duplicateRecords:
      submissions.filter((s) => expected.has(s.blindId)).length -
      new Set(
        submissions
          .filter((s) => expected.has(s.blindId))
          .map((s) => s.blindId),
      ).size,
    foreignRecords: submissions.filter((s) => !expected.has(s.blindId)).length,
    retainedClaims: rows.reduce((n, r) => n + r.retainedClaims, 0),
    resolvedClaimJudgments: rows
      .filter((r) => r.status === "accepted")
      .reduce(
        (n, r) =>
          n +
          r.response!.claims.filter((c) => c.judgement !== "unresolved").length,
        0,
      ),
    unresolvedClaimJudgments: rows
      .filter((r) => r.status === "accepted")
      .reduce(
        (n, r) =>
          n +
          r.response!.claims.filter((c) => c.judgement === "unresolved").length,
        0,
      ),
    unavailableClaimJudgments: rows
      .filter((r) => r.status !== "accepted")
      .reduce((n, r) => n + r.retainedClaims, 0),
    reviewOutputs: Object.fromEntries(
      (["completed", "missing", "invalid", "incomplete"] as const).map(
        (status) => [
          status,
          rows.filter((r) => r.reviewStatus === status).length,
        ],
      ),
    ),
    retainedResponseBlobs: responses.size,
    missingResponseBlobs: missing.size,
  };
  const reviewEvidenceComplete =
    loaded.captured.report.captureInventoryComplete &&
    loaded.captured.report.declaredOutputsComplete &&
    loaded.captured.report.physicalArtifactsVerified;
  const complete =
    counts.accepted === counts.planned &&
    counts.planned > 0 &&
    counts.foreignRecords === 0 &&
    reviewEvidenceComplete;
  return {
    rows,
    responses,
    missing,
    report: {
      schemaVersion: 1 as const,
      profile: "sealed-independent-review-judgments-v1" as const,
      counts,
      judgmentsComplete: complete,
      judgmentsResolved: complete && counts.unresolvedClaimJudgments === 0,
      reviewEvidenceComplete,
      sourceIncluded: false as const,
      privateIdentitiesIncluded: false as const,
      actualAttemptsComplete: false as const,
      hostIndependenceVerified: false as const,
      judgeAuthorityVerified: false as const,
      sourceArchiveBytesVerified: false as const,
      sourcePacketCompletenessVerified: false as const,
      qualityAssessed: false as const,
      gateAClosed: false as const,
      inferenceInvoked: false as const,
    },
  };
}
export function sealReviewEvaluationJudgments(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
  value: unknown,
) {
  if (Array.isArray(value) && value.length > 1536)
    throw Error("Judgment submission count bound exceeded");
  const loaded = loadBook(projectRoot, storageRoot, expectedBookSha256),
    submissions = submissionsSchema.parse(value),
    intakes = judgeIntakes(loaded, submissions, (id) => {
      try {
        return readPrivate(
          path.join(loaded.root, "blobs", id + ".blob"),
          1048576,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  const archive = {
    schemaVersion: 1,
    profile: "sealed-independent-review-judgments-v1",
    bookSha256: expectedBookSha256,
    submissions,
    responses: [...intakes.responses]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([sha256, b]) => ({ sha256, base64: b.toString("base64") })),
    missing: [...intakes.missing].sort(),
  };
  const bytes = encodeReviewEvaluationArtifact(archive);
  writeNew(path.join(loaded.root, "judgments.sealed.json"), bytes);
  return {
    ...intakes.report,
    judgmentsSha256: sha(bytes),
    bookSha256: expectedBookSha256,
  };
}
export function loadSealedReviewEvaluationJudgments(
  projectRoot: string,
  storageRoot: string,
  expectedJudgmentsSha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    bytes = readPrivate(path.join(root, "judgments.sealed.json"), MAX_BOOK);
  if (sha(bytes) !== digest.parse(expectedJudgmentsSha256))
    throw Error("Sealed judgment archive identity changed");
  const archive = sealedSchema.parse(decode(bytes)),
    loaded = loadBook(projectRoot, storageRoot, archive.bookSha256),
    responses = new Map<string, Buffer>();
  for (const row of archive.responses) {
    const b = Buffer.from(row.base64, "base64");
    if (
      b.toString("base64") !== row.base64 ||
      sha(b) !== row.sha256 ||
      responses.has(row.sha256)
    )
      throw Error("Sealed judgment response inventory changed");
    responses.set(row.sha256, b);
  }
  if (
    new Set(archive.missing).size !== archive.missing.length ||
    archive.missing.some((id) => responses.has(id))
  )
    throw Error("Sealed judgment missing inventory changed");
  const intakes = judgeIntakes(
    loaded,
    archive.submissions,
    (id) => responses.get(id) ?? null,
  );
  if (
    intakes.responses.size !== responses.size ||
    !isDeepStrictEqual([...intakes.missing].sort(), archive.missing)
  )
    throw Error("Sealed judgment physical inventory disagrees");
  return {
    loaded,
    intakes,
    report: {
      ...intakes.report,
      judgmentsSha256: sha(bytes),
      bookSha256: archive.bookSha256,
    },
  };
}
export function inspectSealedReviewEvaluationJudgments(
  projectRoot: string,
  storageRoot: string,
  expectedJudgmentsSha256: string,
) {
  return loadSealedReviewEvaluationJudgments(
    projectRoot,
    storageRoot,
    expectedJudgmentsSha256,
  ).report;
}
export type ReviewEvaluationJudgmentsReport = ReturnType<
  typeof sealReviewEvaluationJudgments
>;
