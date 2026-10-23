import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewFamilySchema } from "./review-hypotheses.js";
import { reviewScoringObservationSchema } from "./review-scoring.js";
import {
  inspectReviewEvaluationProtocol,
  reviewEvaluationProtocolInputSchema,
} from "./review-evaluation-protocol.js";
import {
  loadSealedReviewEvaluationJudgments,
  reviewEvaluationReviewOutputSchema,
  reviewEvaluationJudgmentResponseSchema,
} from "./review-evaluation-judging.js";
import {
  evaluationPrivateArtifacts as privateFiles,
  encodeReviewEvaluationArtifact,
} from "./review-evaluation-artifacts.js";
import {
  scoreMultiClaimReviewTrials,
  projectMultiClaimReviewScoring,
  type ReviewMultiReport,
} from "./review-multi-scoring.js";
const { storage, readPrivate, writeNew, decode, sha } = privateFiles;
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  caseId = z.string().regex(/^case-[a-f0-9]{32}$/),
  blindId = z.string().regex(/^matching-[a-f0-9]{32}$/),
  reviewId = z.string().regex(/^judge-[a-f0-9]{32}$/),
  claimId = z.string().regex(/^claim-[a-f0-9]{32}$/),
  defectId = z.string().regex(/^defect-[a-f0-9]{32}$/);
const MAX_FILE = 1048576,
  MAX_TOTAL = 16 * 1048576,
  MAX_BOOK = 32 * 1048576;
export const reviewEvaluationCommonDefectsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("prospective-common-defect-inventory-v1"),
  protocolSha256: digest,
  cases: z
    .array(
      z.strictObject({
        caseId,
        label: reviewScoringObservationSchema.shape.label,
        defects: z
          .array(
            z.strictObject({
              id: defectId,
              family: reviewFamilySchema,
              material: z.boolean(),
              description: z.string().min(1).max(8192),
            }),
          )
          .max(32),
      }),
    )
    .min(1)
    .max(256),
});
type Inventory = z.infer<typeof reviewEvaluationCommonDefectsSchema>;
const bookSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("independent-common-defect-matching-v1"),
  judgmentsSha256: digest,
  inventorySha256: digest,
  protocolSha256: digest,
  procedureSha256: digest,
  salt: digest,
  cases: z.array(z.strictObject({ caseId, blindId })).min(1).max(256),
});
const submissionsSchema = z
  .array(z.strictObject({ blindId, responseSha256: digest.nullable() }))
  .max(512);
export const reviewEvaluationMappingResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("independent-common-defect-mapping-v1"),
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
  mappings: z
    .array(z.strictObject({ reviewId, claimId, defectId: defectId.nullable() }))
    .max(192),
});
const sealedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("sealed-independent-common-defect-mappings-v1"),
  bookSha256: digest,
  submissions: submissionsSchema,
  responses: z
    .array(
      z.strictObject({
        sha256: digest,
        base64: z.string().max(Math.ceil(MAX_FILE / 3) * 4),
      }),
    )
    .max(512),
  missing: z.array(digest).max(512),
});
const key = (r: { caseId: string; repetition: number; role: string }) =>
  JSON.stringify([r.caseId, r.repetition, r.role]);
function validateInventory(
  value: unknown,
  declaration: unknown,
  expectedProtocolSha256: string,
) {
  const protocol = reviewEvaluationProtocolInputSchema.parse(declaration),
    report = inspectReviewEvaluationProtocol(protocol, expectedProtocolSha256);
  if (!report.declarationComplete)
    throw Error("Common inventory requires a complete protocol declaration");
  const caseRows = (value as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(caseRows) || caseRows.length > 256)
    throw Error("Common inventory case bound exceeded");
  for (const row of caseRows) {
    const defects = (row as { defects?: unknown } | null)?.defects;
    if (Array.isArray(defects) && defects.length > 32)
      throw Error("Common inventory per-case defect bound exceeded");
  }
  const inventory = reviewEvaluationCommonDefectsSchema.parse(value),
    expected = new Set(
      protocol.cohort.cases
        .filter((c) => c.disposition.status === "selected")
        .map((c) => c.id),
    );
  if (
    inventory.protocolSha256 !== expectedProtocolSha256 ||
    inventory.cases.length !== expected.size ||
    new Set(inventory.cases.map((c) => c.caseId)).size !== expected.size ||
    inventory.cases.some((c) => !expected.has(c.caseId))
  )
    throw Error("Common inventory protocol or case identities disagree");
  let total = 0;
  for (const row of inventory.cases) {
    if (
      new Set(row.defects.map((d) => d.id)).size !== row.defects.length ||
      (row.label === "defect"
        ? row.defects.length === 0
        : row.defects.length !== 0)
    )
      throw Error("Common defect identities or labels disagree");
    total += row.defects.length;
  }
  if (total > 4096) throw Error("Common inventory defect bound exceeded");
  return inventory;
}
/** Freeze operator labels separately before local physical capture sealing; no claim of external chronology or authority. */
export function freezeReviewEvaluationCommonDefects(
  projectRoot: string,
  storageRoot: string,
  declaration: unknown,
  expectedProtocolSha256: string,
  value: unknown,
) {
  const root = storage(projectRoot, storageRoot);
  if (existsSync(path.join(root, "captures.sealed.json")))
    throw Error("Common inventory must precede local capture sealing");
  const inventory = validateInventory(
      value,
      declaration,
      expectedProtocolSha256,
    ),
    bytes = encodeReviewEvaluationArtifact(inventory);
  if (bytes.length > 8 * 1048576)
    throw Error("Common inventory byte bound exceeded");
  writeNew(path.join(root, "common-defects.frozen.json"), bytes);
  return {
    schemaVersion: 1 as const,
    inventorySha256: sha(bytes),
    protocolSha256: expectedProtocolSha256,
    cases: inventory.cases.length,
    defects: inventory.cases.reduce((n, c) => n + c.defects.length, 0),
    localCaptureAlreadySealed: false as const,
    chronologyVerified: false as const,
    labelsVerified: false as const,
    sourceIncluded: false as const,
    gateAClosed: false as const,
    inferenceInvoked: false as const,
  };
}
function caseBook(inventory: Inventory, salt: string) {
  return inventory.cases
    .map((c) => c.caseId)
    .sort()
    .map((caseId) => ({
      caseId,
      blindId:
        "matching-" +
        sha(encodeReviewEvaluationArtifact([salt, caseId])).slice(0, 32),
    }));
}
function loadBook(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    bytes = readPrivate(path.join(root, "matching.book.json"), MAX_BOOK);
  if (sha(bytes) !== digest.parse(expectedBookSha256))
    throw Error("Matching book identity changed");
  const book = bookSchema.parse(decode(bytes)),
    judged = loadSealedReviewEvaluationJudgments(
      projectRoot,
      storageRoot,
      book.judgmentsSha256,
    ),
    raw = readPrivate(
      path.join(root, "common-defects.frozen.json"),
      8 * 1048576,
    );
  if (sha(raw) !== book.inventorySha256)
    throw Error("Frozen common inventory changed");
  const declaration = judged.loaded.captured.input.declaration,
    inventory = validateInventory(
      decode(raw),
      declaration,
      book.protocolSha256,
    );
  if (
    book.protocolSha256 !== judged.loaded.book.protocolSha256 ||
    book.procedureSha256 !==
      declaration.protocol.procedures.commonDefectMatchingSha256 ||
    !isDeepStrictEqual(book.cases, caseBook(inventory, book.salt))
  )
    throw Error("Matching book bindings disagree");
  return { root, book, judged, inventory };
}
function reviewFor(
  loaded: ReturnType<typeof loadBook>,
  slot: ReturnType<
    typeof loadBook
  >["judged"]["loaded"]["book"]["slots"][number],
) {
  const judgment = loaded.judged.intakes.rows.find(
    (j) => j.blindId === slot.blindId,
  )!;
  if (judgment.reviewStatus !== "completed")
    return {
      status: judgment.reviewStatus,
      claims: [] as z.infer<
        typeof reviewEvaluationReviewOutputSchema
      >["claims"],
    };
  const c = loaded.judged.loaded.captured.input.captures.find(
    (c) => key(c) === key(slot),
  )!;
  return {
    status: judgment.reviewStatus,
    claims: reviewEvaluationReviewOutputSchema.parse(
      decode(loaded.judged.loaded.captured.records.get(c.output!.sha256)!),
    ).claims,
  };
}
function packetFor(loaded: ReturnType<typeof loadBook>, id: string) {
  const slot = loaded.book.cases.find((c) => c.blindId === id);
  if (!slot) throw Error("Unknown matching slot");
  const inventory = loaded.inventory.cases.find(
      (c) => c.caseId === slot.caseId,
    )!,
    reviews = loaded.judged.loaded.book.slots
      .filter((s) => s.caseId === slot.caseId)
      .map((s) => {
        const r = reviewFor(loaded, s);
        return {
          reviewId: s.blindId,
          status: r.status,
          claims: r.claims.map(({ probability, ...c }) => {
            void probability;
            return c;
          }),
        };
      });
  const packet = {
    schemaVersion: 1 as const,
    profile: "anonymous-common-defect-matching-packet-v1" as const,
    blindId: id,
    procedureSha256: loaded.book.procedureSha256,
    source: loaded.judged.loaded.sources.get(slot.caseId)!,
    label: inventory.label,
    defects: inventory.defects,
    reviews,
    instructions:
      "Map every retained claim to the common defect inventory or null. Different claims can denote the same defect. No review role, probability or prior judge disposition is supplied. A mapping does not establish claim truth.",
  };
  const packetSha256 = sha(encodeReviewEvaluationArtifact(packet));
  if (
    encodeReviewEvaluationArtifact({ ...packet, packetSha256 }).length >
    4 * 1048576
  )
    throw Error("Matching packet exceeds disclosure bound");
  return { slot, packet, packetSha256 };
}
export function prepareReviewEvaluationMatching(
  projectRoot: string,
  storageRoot: string,
  expectedJudgmentsSha256: string,
  expectedInventorySha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    judged = loadSealedReviewEvaluationJudgments(
      projectRoot,
      storageRoot,
      expectedJudgmentsSha256,
    ),
    raw = readPrivate(
      path.join(root, "common-defects.frozen.json"),
      8 * 1048576,
    );
  if (sha(raw) !== digest.parse(expectedInventorySha256))
    throw Error("Frozen common inventory changed");
  const inventory = validateInventory(
      decode(raw),
      judged.loaded.captured.input.declaration,
      judged.loaded.book.protocolSha256,
    ),
    salt = randomBytes(32).toString("hex"),
    book = bookSchema.parse({
      schemaVersion: 1,
      profile: "independent-common-defect-matching-v1",
      judgmentsSha256: expectedJudgmentsSha256,
      inventorySha256: expectedInventorySha256,
      protocolSha256: inventory.protocolSha256,
      procedureSha256:
        judged.loaded.captured.input.declaration.protocol.procedures
          .commonDefectMatchingSha256,
      salt,
      cases: caseBook(inventory, salt),
    }),
    prepared = { root, book, judged, inventory };
  if (new Set(book.cases.map((c) => c.blindId)).size !== book.cases.length)
    throw Error("Matching identity collision");
  for (const row of book.cases) packetFor(prepared, row.blindId);
  const bytes = encodeReviewEvaluationArtifact(book);
  writeNew(path.join(root, "matching.book.json"), bytes);
  return {
    schemaVersion: 1 as const,
    bookSha256: sha(bytes),
    plannedMappings: book.cases.length,
    blindIds: book.cases.map((c) => c.blindId),
    sourceIncluded: false as const,
    inferenceInvoked: false as const,
    gateAClosed: false as const,
  };
}
export function reviewEvaluationMatchingPacket(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
  id: string,
  allowSource: boolean,
) {
  if (allowSource !== true)
    throw Error("Matching source disclosure requires the operator grant");
  const loaded = loadBook(projectRoot, storageRoot, expectedBookSha256),
    p = packetFor(loaded, blindId.parse(id));
  return { ...p.packet, packetSha256: p.packetSha256 };
}
function intakes(
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
      bytes.length > MAX_FILE ||
      sha(bytes) !== id ||
      (total += bytes.length) > MAX_TOTAL
    )
      throw Error("Matching response identity or bound disagrees");
    responses.set(id, bytes);
    return bytes;
  };
  const parsed = new Map<
    string,
    z.infer<typeof reviewEvaluationMappingResponseSchema>
  >();
  for (const s of submissions) {
    if (!s.responseSha256) continue;
    const bytes = get(s.responseSha256);
    if (!bytes) continue;
    try {
      parsed.set(
        s.responseSha256,
        reviewEvaluationMappingResponseSchema.parse(decode(bytes)),
      );
    } catch {
      /* malformed reached responses remain retained */
    }
  }
  const sessions = new Map<string, number>();
  for (const s of submissions) {
    const p = s.responseSha256 ? parsed.get(s.responseSha256) : undefined;
    if (p) sessions.set(p.sessionId, (sessions.get(p.sessionId) ?? 0) + 1);
  }
  const previous = new Set(
    loaded.judged.loaded.captured.input.metering.slots.flatMap((s) =>
      s.attempts.map((a) => a.sessionId),
    ),
  );
  for (const bytes of loaded.judged.intakes.responses.values()) {
    try {
      previous.add(
        reviewEvaluationJudgmentResponseSchema.parse(decode(bytes)).sessionId,
      );
    } catch {
      /* Unknown malformed sessions cannot be authenticated. */
    }
  }
  const rows = loaded.book.cases.map((slot) => {
    const list = received.get(slot.blindId) ?? [],
      packet = packetFor(loaded, slot.blindId),
      expected = packet.packet.reviews.flatMap((r) =>
        r.claims.map((c) => ({
          reviewId: r.reviewId,
          claimId: c.id,
          family: c.family,
        })),
      );
    let status:
      | "accepted"
      | "missing"
      | "duplicate"
      | "invalid"
      | "foreign"
      | "incomplete"
      | "session-reuse" = "missing";
    let response: z.infer<typeof reviewEvaluationMappingResponseSchema> | null =
      null;
    if (list.length > 1) status = "duplicate";
    else if (list.length === 1 && list[0]!.responseSha256) {
      response = parsed.get(list[0]!.responseSha256!) ?? null;
      status = "invalid";
      if (response) {
        if (
          sessions.get(response.sessionId)! > 1 ||
          previous.has(response.sessionId)
        )
          status = "session-reuse";
        else if (response.packetSha256 !== packet.packetSha256)
          status = "foreign";
        else if (response.status !== "completed") status = "incomplete";
        else if (
          response.mappings.length === expected.length &&
          new Set(
            response.mappings.map((m) =>
              JSON.stringify([m.reviewId, m.claimId]),
            ),
          ).size === response.mappings.length &&
          response.mappings.every((m) => {
            const c = expected.find(
              (c) => c.reviewId === m.reviewId && c.claimId === m.claimId,
            );
            return (
              c &&
              (m.defectId === null ||
                packet.packet.defects.some(
                  (d) => d.id === m.defectId && d.family === c.family,
                ))
            );
          })
        )
          status = "accepted";
      }
    }
    return {
      blindId: slot.blindId,
      status,
      response,
      retainedClaims: expected.length,
    };
  });
  const expected = new Set(loaded.book.cases.map((c) => c.blindId)),
    counts = {
      planned: rows.length,
      accepted: rows.filter((r) => r.status === "accepted").length,
      missing: rows.filter((r) => r.status === "missing").length,
      rejected: rows.filter((r) => !["accepted", "missing"].includes(r.status))
        .length,
      supplied: submissions.length,
      receivedUniquePlanned: new Set(
        submissions
          .filter((s) => expected.has(s.blindId))
          .map((s) => s.blindId),
      ).size,
      duplicateRecords:
        submissions.filter((s) => expected.has(s.blindId)).length -
        new Set(
          submissions
            .filter((s) => expected.has(s.blindId))
            .map((s) => s.blindId),
        ).size,
      foreignRecords: submissions.filter((s) => !expected.has(s.blindId))
        .length,
      retainedClaims: rows.reduce((n, r) => n + r.retainedClaims, 0),
      mappedClaims: rows
        .filter((r) => r.status === "accepted")
        .reduce(
          (n, r) =>
            n + r.response!.mappings.filter((m) => m.defectId !== null).length,
          0,
        ),
      unmappedClaims: rows
        .filter((r) => r.status === "accepted")
        .reduce(
          (n, r) =>
            n + r.response!.mappings.filter((m) => m.defectId === null).length,
          0,
        ),
      unavailableClaimMappings: rows
        .filter((r) => r.status !== "accepted")
        .reduce((n, r) => n + r.retainedClaims, 0),
      retainedResponseBlobs: responses.size,
      missingResponseBlobs: missing.size,
    };
  return {
    rows,
    responses,
    missing,
    report: {
      schemaVersion: 1 as const,
      profile: "sealed-independent-common-defect-mappings-v1" as const,
      counts,
      mappingsComplete:
        counts.planned > 0 &&
        counts.accepted === counts.planned &&
        counts.foreignRecords === 0,
      judgmentsComplete: loaded.judged.report.judgmentsComplete,
      judgmentsResolved: loaded.judged.report.judgmentsResolved,
      sourceIncluded: false as const,
      privateIdentitiesIncluded: false as const,
      actualAttemptsComplete: false as const,
      hostIndependenceVerified: false as const,
      commonDefectAuthorityVerified: false as const,
      qualityAssessed: false as const,
      gateAClosed: false as const,
      inferenceInvoked: false as const,
    },
  };
}
export function sealReviewEvaluationMappings(
  projectRoot: string,
  storageRoot: string,
  expectedBookSha256: string,
  value: unknown,
) {
  if (Array.isArray(value) && value.length > 512)
    throw Error("Matching submission count bound exceeded");
  const loaded = loadBook(projectRoot, storageRoot, expectedBookSha256),
    submissions = submissionsSchema.parse(value),
    loadedIntakes = intakes(loaded, submissions, (id) => {
      try {
        return readPrivate(
          path.join(loaded.root, "blobs", id + ".blob"),
          MAX_FILE,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
    archive = {
      schemaVersion: 1,
      profile: "sealed-independent-common-defect-mappings-v1",
      bookSha256: expectedBookSha256,
      submissions,
      responses: [...loadedIntakes.responses]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([sha256, b]) => ({ sha256, base64: b.toString("base64") })),
      missing: [...loadedIntakes.missing].sort(),
    };
  const bytes = encodeReviewEvaluationArtifact(archive);
  writeNew(path.join(loaded.root, "mappings.sealed.json"), bytes);
  return {
    ...loadedIntakes.report,
    bookSha256: expectedBookSha256,
    mappingsSha256: sha(bytes),
  };
}
function loadMappings(
  projectRoot: string,
  storageRoot: string,
  expectedMappingsSha256: string,
) {
  const root = storage(projectRoot, storageRoot),
    bytes = readPrivate(path.join(root, "mappings.sealed.json"), MAX_BOOK);
  if (sha(bytes) !== digest.parse(expectedMappingsSha256))
    throw Error("Sealed mappings identity changed");
  const archive = sealedSchema.parse(decode(bytes)),
    loaded = loadBook(projectRoot, storageRoot, archive.bookSha256),
    responses = new Map<string, Buffer>();
  for (const row of archive.responses) {
    const b = Buffer.from(row.base64, "base64");
    if (
      responses.has(row.sha256) ||
      b.toString("base64") !== row.base64 ||
      sha(b) !== row.sha256
    )
      throw Error("Sealed mapping response inventory changed");
    responses.set(row.sha256, b);
  }
  if (
    new Set(archive.missing).size !== archive.missing.length ||
    archive.missing.some((id) => responses.has(id))
  )
    throw Error("Sealed mapping missing inventory changed");
  const loadedIntakes = intakes(
    loaded,
    archive.submissions,
    (id) => responses.get(id) ?? null,
  );
  if (
    loadedIntakes.responses.size !== responses.size ||
    !isDeepStrictEqual([...loadedIntakes.missing].sort(), archive.missing)
  )
    throw Error("Sealed mapping physical inventory disagrees");
  return {
    loaded,
    intakes: loadedIntakes,
    report: {
      ...loadedIntakes.report,
      bookSha256: archive.bookSha256,
      mappingsSha256: sha(bytes),
    },
  };
}
export function inspectSealedReviewEvaluationMappings(
  projectRoot: string,
  storageRoot: string,
  expectedMappingsSha256: string,
) {
  return loadMappings(projectRoot, storageRoot, expectedMappingsSha256).report;
}
/** Descriptive paired scores derive from immutable reviewer probabilities, separate judgments and common mappings. */
export function scoreReviewEvaluationArtifacts(
  projectRoot: string,
  storageRoot: string,
  expectedMappingsSha256: string,
) {
  const mapped = loadMappings(projectRoot, storageRoot, expectedMappingsSha256),
    { loaded } = mapped,
    declaration = loaded.judged.loaded.captured.input.declaration,
    selected = declaration.cohort.cases
      .filter((c) => c.disposition.status === "selected")
      .sort((a, b) => a.id.localeCompare(b.id, "en")),
    clusters = new Map(
      declaration.protocol.caseClusters.map((c) => [c.caseId, c.clusterId]),
    );
  const trials = selected.flatMap((c) =>
      Array.from(
        { length: declaration.protocol.scoring.repetitions },
        (_, repetition) => ({
          id: "trial-" + c.id.slice(5) + "-" + repetition,
          caseId: c.id,
          repetition,
          clusterId: clusters.get(c.id)!,
        }),
      ),
    ),
    labels = trials.map((t) => {
      const c = loaded.inventory.cases.find((c) => c.caseId === t.caseId)!;
      return {
        id: t.id,
        label: c.label,
        defects: c.defects.map(({ description, ...d }) => {
          void description;
          return d;
        }),
      };
    });
  type Observations = ReviewMultiReport["input"]["observations"]["a"];
  const observations = (
    role: "baseline" | "verifier" | "reference",
  ): Observations =>
    trials.map((t) => {
      const slot = loaded.judged.loaded.book.slots.find(
          (s) =>
            s.caseId === t.caseId &&
            s.repetition === t.repetition &&
            s.role === role,
        )!,
        review = reviewFor(loaded, slot),
        judge = loaded.judged.intakes.rows.find(
          (r) => r.blindId === slot.blindId,
        )!,
        mappingCase = loaded.book.cases.find((c) => c.caseId === slot.caseId)!,
        mapping = mapped.intakes.rows.find(
          (r) => r.blindId === mappingCase.blindId,
        )!;
      const physical = loaded.judged.loaded.captured.input.captures.find(
        (c) => key(c) === key(slot),
      );
      const status =
        review.status === "completed"
          ? "completed"
          : physical?.status === "cancelled"
            ? "cancelled"
            : physical?.status === "budget-exhausted"
              ? "budget-exhausted"
              : physical?.status === "not-run"
                ? "unreviewed"
                : "incomplete";
      return {
        id: t.id,
        status,
        claims: review.claims.map((c) => {
          const judged =
              judge.status === "accepted"
                ? judge.response!.claims.find((x) => x.id === c.id)
                : undefined,
            common =
              mapping.status === "accepted"
                ? mapping.response!.mappings.find(
                    (m) => m.reviewId === slot.blindId && m.claimId === c.id,
                  )
                : undefined;
          const judgement =
            judged?.judgement === "supported"
              ? common?.defectId
                ? "supported"
                : "unresolved"
              : (judged?.judgement ?? "unresolved");
          return {
            id: c.id,
            family: c.family,
            judgement,
            defectId: judgement === "supported" ? common!.defectId : null,
            probability: c.probability,
          };
        }),
      };
    });
  const protocol = {
    schemaVersion: 1 as const,
    profile: "declared-multi-claim-paired-v1" as const,
    purpose: "held-out" as const,
    seed: declaration.protocol.scoring.seed,
    resamples: declaration.protocol.scoring.resamples,
    confidenceLevel: declaration.protocol.scoring.confidenceLevel,
    trials: trials.map(({ id, clusterId }) => ({ id, clusterId })),
  };
  const verifier = observations("verifier"),
    scores = {
      baseline: scoreMultiClaimReviewTrials({
        protocol,
        labels,
        observations: { a: observations("baseline"), b: verifier },
      }),
      reference: scoreMultiClaimReviewTrials({
        protocol,
        labels,
        observations: { a: observations("reference"), b: verifier },
      }),
    };
  return {
    schemaVersion: 1 as const,
    profile: "sealed-three-role-external-review-scoring-v1" as const,
    protocolSha256: loaded.book.protocolSha256,
    inventorySha256: loaded.book.inventorySha256,
    judgmentsSha256: loaded.book.judgmentsSha256,
    mappingsSha256: expectedMappingsSha256,
    scoringBindingsComplete:
      loaded.judged.report.judgmentsResolved &&
      mapped.report.mappingsComplete &&
      loaded.inventory.cases.every((c) => c.label !== "unresolved"),
    measurementAccountingComplete:
      loaded.judged.loaded.captured.report.measurementAccountingComplete,
    accounting: { judgments: loaded.judged.report, mappings: mapped.report },
    comparisons: {
      baseline: projectMultiClaimReviewScoring(scores.baseline, false),
      reference: projectMultiClaimReviewScoring(scores.reference, false),
    },
    probabilitySource: "sealed-reviewer-declared-uncalibrated" as const,
    labelSource: "frozen-operator-supplied-unverified-common-defects" as const,
    declaredPurpose: "reserved-cohort-not-independently-verified" as const,
    sourceIncluded: false as const,
    privateIdentitiesIncluded: false as const,
    claimTruthVerified: false as const,
    labelsVerified: false as const,
    hostIndependenceVerified: false as const,
    actualAttemptsComplete: false as const,
    qualityAssessed: false as const,
    gateAClosed: false as const,
    inferenceInvoked: false as const,
  };
}
export type ReviewEvaluationMappingsReport = ReturnType<
  typeof sealReviewEvaluationMappings
>;
export type ReviewEvaluationArtifactScores = ReturnType<
  typeof scoreReviewEvaluationArtifacts
>;
