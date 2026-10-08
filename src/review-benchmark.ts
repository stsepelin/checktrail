import {
  scoreMultiClaimReviewTrials,
  projectMultiClaimReviewScoring,
  reviewMultiInputSchema,
} from "./review-multi-scoring.js";
import { projectReviewCandidateForIndependentStage } from "./review-provider-schema.js";
import { projectReviewNativeObservations } from "./review-adjudication.js";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  scorePairedReviewTrials,
  projectPairedReviewScoring,
  reviewPairedInputSchema,
} from "./review-paired-scoring.js";
import { reviewNativeBudgetLimitsSchema } from "./review-probe-schema.js";
import { observeReviewEngineDigest } from "./review-engine-identity.js";
import { VERSION } from "./types.js";
import { parseReviewContext } from "./review.js";
import {
  parseReviewWorkflowAuditArtifact,
  readReviewWorkflowAuditBytes,
} from "./review-workflow-audit.js";
import { reviewWorkflowAuditBindingSchema } from "./review-workflow-audit-schema.js";
import {
  reviewWorkflowSelectedLimitsSchema,
  reviewWorkflowResponseSchema,
  reviewWorkflowCommandSchema,
} from "./review-workflow-schema.js";
import {
  reviewBenchmarkMultiScoreReportSchema,
  reviewBenchmarkMultiScoreSummarySchema,
  reviewBenchmarkMatchingPacketSchema,
  reviewBenchmarkMatchingResponseSchema,
  reviewBenchmarkMatchingBookSchema,
  reviewBenchmarkMappingArchiveSchema,
  reviewBenchmarkMatchingWorkerSummarySchema,
  reviewBenchmarkPlanSchema,
  reviewBenchmarkScoreReportSchema,
  reviewBenchmarkScoreSummarySchema,
  reviewBenchmarkReferenceSchema,
  reviewBenchmarkCommandSchema,
  reviewBenchmarkSummarySchema,
  reviewBenchmarkPacketSchema,
  reviewBenchmarkJudgingSchema,
  reviewBenchmarkWorkerCommandSchema,
  reviewBenchmarkWorkerSummarySchema,
  reviewBenchmarkJudgePacketSchema,
  reviewBenchmarkJudgmentResponseSchema,
  reviewBenchmarkJudgmentArchiveSchema,
  reviewBenchmarkJudgeWorkerSummarySchema,
  type ReviewBenchmarkReference,
} from "./review-benchmark-schema.js";
const MANIFEST_BYTES = 16_777_216;
const JOURNAL_BYTES = 4_194_304;
const JUDGE_PACKET_BYTES = 16_777_216;
const JUDGMENT_BYTES = 262_144;
const JUDGMENT_ARCHIVE_BYTES = 8_388_608;
const COLLECTION_BYTES = 134_217_728;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const trialSchema = z.strictObject({
  trialId: z.string().uuid(),
  blindId: z.string().uuid(),
  matchingId: z.string().uuid().optional(),
  caseIndex: z.number().int().min(0).max(3),
  armIndex: z.number().int().min(0).max(1),
  repetition: z.number().int().min(0).max(1),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  engineRuntimeDigest: digest,
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
  plan: reviewBenchmarkPlanSchema,
  trials: z.array(trialSchema).min(2).max(16),
});
const intakeSchema = z.strictObject({
  trialId: z.string().uuid(),
  status:
    reviewBenchmarkSummarySchema.shape.trials.element.shape.status.exclude([
      "uncollected",
    ]),
  journalDigest: digest.nullable(),
  journalBase64: z.string().max(5_592_408).nullable(),
});
const collectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocolDigest: digest,
  createdAt: z.string().datetime(),
  trials: z.array(intakeSchema).min(2).max(16),
});
type Manifest = z.infer<typeof manifestSchema>;
type Trial = z.infer<typeof trialSchema>;
type Intake = z.infer<typeof intakeSchema>;
function matchingBinding(
  book: z.infer<typeof reviewBenchmarkMatchingBookSchema>,
) {
  const {
    schemaVersion,
    protocolDigest,
    collectionDigest,
    judgingDigest,
    judgmentsDigest,
  } = book;
  return {
    schemaVersion,
    protocolDigest,
    collectionDigest,
    judgingDigest,
    judgmentsDigest,
  };
}
function equal(a: unknown, b: unknown): boolean {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, sort(v)]),
          )
        : v;
  return JSON.stringify(sort(a)) === JSON.stringify(sort(b));
}
function directory(filename: string): string {
  if (process.platform === "win32" || !path.isAbsolute(filename))
    throw new Error(
      "Benchmark storage requires an absolute private POSIX directory",
    );
  const stat = lstatSync(filename);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error(
      "Benchmark directory must be private and owned by the operator",
    );
  return realpathSync(filename);
}
function outside(root: string, target: string): void {
  const relative = path.relative(realpathSync(root), target);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("Benchmark storage must be outside the project root");
}
function readPrivate(filename: string, maxBytes: number): Buffer {
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
      before.size > maxBytes
    )
      throw new Error(
        "Benchmark artifact must be a bounded private singly linked file",
      );
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error("Benchmark artifact read ended early");
      offset += n;
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
      throw new Error("Benchmark artifact changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function writeNew(filename: string, value: unknown, maxBytes: number): string {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > maxBytes)
    throw new Error("Benchmark artifact exceeds bounds");
  const parent = directory(path.dirname(filename)),
    temporary = path.join(parent, `.pending-${randomUUID()}`);
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!n) throw new Error("Benchmark write made no progress");
        offset += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // link is exclusive; rename could silently replace an earlier collection.
    linkSync(temporary, filename);
  } finally {
    unlinkSync(temporary);
  }
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
  return sha(bytes);
}
function decode(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function checkedManifest(value: unknown): Manifest {
  const manifest = manifestSchema.parse(value),
    plan = manifest.plan;
  if (
    manifest.engineVersion !== VERSION ||
    manifest.engineRuntimeDigest !== observeReviewEngineDigest() ||
    plan.arms[0].id === plan.arms[1].id ||
    new Set(plan.cases.map((c) => c.id)).size !== plan.cases.length
  )
    throw new Error("Benchmark engine or plan identity disagrees");
  if (plan.multiScoring) {
    const settings = plan.multiScoring;
    const declared = new Map(settings.cases.map((c) => [c.id, c]));
    if (
      plan.scoring ||
      !plan.judging ||
      declared.size !== settings.cases.length ||
      declared.size !== plan.cases.length
    )
      throw new Error(
        "Multi-claim scoring requires frozen independent judging and one exact common inventory",
      );
    for (const c of plan.cases) {
      const row = declared.get(c.id);
      const expected = new Set(c.labels.expectedDefects.map((d) => d.id));
      if (
        !row ||
        expected.size !== c.labels.expectedDefects.length ||
        new Set(row.defects.map((d) => d.id)).size !== row.defects.length ||
        row.defects.length !== expected.size ||
        row.defects.some((d) => !expected.has(d.id)) ||
        (c.labels.variant === "broken"
          ? !row.defects.length
          : row.defects.length !== 0)
      )
        throw new Error(
          "Multi-claim common defects must exactly match each frozen synthetic variant",
        );
    }
  }
  if (plan.scoring) {
    const declared = new Set(plan.scoring.cases.map((c) => c.id));
    if (
      !plan.judging ||
      declared.size !== plan.scoring.cases.length ||
      declared.size !== plan.cases.length ||
      plan.cases.some((c) => !declared.has(c.id)) ||
      plan.cases.some(
        (c) =>
          c.labels.variant === "broken" &&
          c.labels.expectedDefects.length !== 1,
      )
    )
      throw new Error(
        "Benchmark scoring requires frozen judging, exact case families and one expected defect per broken case",
      );
  }
  for (const arm of plan.arms) {
    const limits = reviewWorkflowSelectedLimitsSchema.parse(
      arm.settings.workflowLimits,
    );
    reviewNativeBudgetLimitsSchema.parse(arm.settings.nativeBudget);
    if (
      arm.settings.nativeWallMs < 1 ||
      arm.settings.nativeWallMs > 120_000 ||
      arm.settings.maxNativeOutputBytes < 1 ||
      arm.settings.maxNativeOutputBytes > 1_048_576
    )
      throw new Error("Benchmark native startup limits are unsupported");
    if (limits.maxWorkflows !== 1)
      throw new Error("Each benchmark trial requires a one-workflow epoch");
    if (
      new Set(arm.settings.probes.map((p) => p.id)).size !==
      arm.settings.probes.length
    )
      throw new Error("Duplicate benchmark probe identity");
  }
  for (const c of plan.cases) {
    const context = parseReviewContext(c.context);
    if (
      context.schemaVersion !== 5 ||
      context.selection.track !== "snapshot" ||
      context.selection.currentSource !== "working-tree"
    )
      throw new Error(
        "Synthetic readiness requires version 5 working-tree snapshots",
      );
    if (
      new Set(c.labels.expectedDefects.map((d) => d.id)).size !==
        c.labels.expectedDefects.length ||
      (c.labels.variant !== "broken" && c.labels.expectedDefects.length)
    )
      throw new Error("Synthetic labels disagree with their declared variant");
  }
  const expected = new Set<string>();
  for (let c = 0; c < plan.cases.length; c++)
    for (let r = 0; r < plan.repetitions; r++)
      for (let a = 0; a < 2; a++) expected.add(`${c}:${r}:${a}`);
  const ids = new Set<string>();
  for (const trial of manifest.trials) {
    if (
      !expected.delete(
        `${trial.caseIndex}:${trial.repetition}:${trial.armIndex}`,
      ) ||
      trial.trialId === trial.blindId ||
      ids.has(trial.trialId) ||
      ids.has(trial.blindId)
    )
      throw new Error("Benchmark trial inventory disagrees");
    if (
      Boolean(trial.matchingId) !== Boolean(plan.multiScoring) ||
      (trial.matchingId &&
        (ids.has(trial.matchingId) ||
          trial.matchingId === trial.trialId ||
          trial.matchingId === trial.blindId))
    )
      throw new Error("Benchmark matching inventory disagrees");
    if (trial.matchingId) ids.add(trial.matchingId);
    ids.add(trial.trialId);
    ids.add(trial.blindId);
  }
  if (expected.size) throw new Error("Benchmark planned trials are missing");
  return manifest;
}
/** Freeze only original synthetic readiness inputs. No model or project code runs. */
export function freezeReviewBenchmark(
  root: string,
  input: unknown,
  destination: string,
) {
  const plan = reviewBenchmarkPlanSchema.parse(input),
    trials: Trial[] = [];
  for (let c = 0; c < plan.cases.length; c++)
    for (let r = 0; r < plan.repetitions; r++) {
      const first = randomInt(2);
      for (const a of [first, 1 - first])
        trials.push({
          trialId: randomUUID(),
          blindId: randomUUID(),
          ...(plan.multiScoring ? { matchingId: randomUUID() } : {}),
          caseIndex: c,
          armIndex: a,
          repetition: r,
        });
    }
  const manifest = checkedManifest({
    schemaVersion: 1,
    engineVersion: VERSION,
    engineRuntimeDigest: observeReviewEngineDigest(),
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    plan,
    trials,
  });
  if (!path.isAbsolute(destination))
    throw new Error("Benchmark destination must be absolute");
  const parent = directory(path.dirname(destination)),
    target = path.join(parent, path.basename(destination));
  outside(root, target);
  if (existsSync(target))
    throw new Error("Benchmark destination already exists");
  // Resolve/validate every input before writing any artifact. Failed writes roll back our fresh directory.
  const bytes = Buffer.byteLength(JSON.stringify(manifest) + "\n");
  if (bytes > MANIFEST_BYTES)
    throw new Error("Benchmark manifest exceeds bounds");
  mkdirSync(target, { mode: 0o700 });
  try {
    mkdirSync(path.join(target, "journals"), { mode: 0o700 });
    if (plan.judging)
      mkdirSync(path.join(target, "judgments"), { mode: 0o700 });
    if (plan.multiScoring)
      mkdirSync(path.join(target, "mappings"), { mode: 0o700 });
    const digest = writeNew(
      path.join(target, "manifest.json"),
      manifest,
      MANIFEST_BYTES,
    );
    return {
      reference: { directory: target, sha256: digest },
      summary: new ReviewBenchmark(root, {
        directory: target,
        sha256: digest,
      }).status(),
    };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
type Artifact = ReturnType<typeof parseReviewWorkflowAuditArtifact>;
function binding(manifest: Manifest, trial: Trial, protocolDigest: string) {
  return reviewWorkflowAuditBindingSchema.parse({
    runId: manifest.runId,
    trialId: trial.trialId,
    protocolDigest,
  });
}
function checkTrial(
  artifact: Artifact,
  manifest: Manifest,
  trial: Trial,
  protocolDigest: string,
): boolean {
  const { header, summary, events } = artifact,
    arm = manifest.plan.arms[trial.armIndex]!,
    c = manifest.plan.cases[trial.caseIndex]!;
  if (
    summary.journalVersion !== 2 ||
    header.engineVersion !== manifest.engineVersion ||
    header.engineRuntimeDigest !== manifest.engineRuntimeDigest ||
    !equal(header.binding, binding(manifest, trial, protocolDigest)) ||
    !equal(header.runtime, manifest.plan.runtime) ||
    !equal(header.settings, arm.settings) ||
    header.maxBytes !== JOURNAL_BYTES ||
    header.maxEvents !== 256 ||
    summary.workflows.length > 1
  )
    return false;
  for (const state of summary.workflows)
    if (
      state.schemaVersion !== 1 ||
      state.contextDigest !== c.context.contextDigest ||
      !equal(state.limits, arm.settings.workflowLimits)
    )
      return false;
  for (const event of events) {
    if (
      event.body.kind === "finish" &&
      event.body.result?.format === "review-workflow-assignment"
    ) {
      const assignment = event.body.result;
      if (assignment.contextDigest !== c.context.contextDigest) return false;
      if (assignment.stage === "reviewer") {
        try {
          if (
            !equal(
              parseReviewContext(JSON.parse(assignment.packet).context),
              c.context,
            )
          )
            return false;
        } catch {
          return false;
        }
      }
    }
    if (event.body.kind !== "begin") continue;
    const command = reviewWorkflowCommandSchema.safeParse(
      event.body.capture.value,
    );
    if (!command.success || command.data.operation !== "submit") continue;
    const response = reviewWorkflowResponseSchema.safeParse(
      command.data.response,
    );
    if (!response.success) continue;
    const host = {
      client: response.data.host.client,
      clientVersion: response.data.host.clientVersion,
      provider: response.data.host.provider,
      model: response.data.host.model,
    };
    if (!equal(host, arm.host)) return false;
  }
  return true;
}
function declaredSessions(artifact: Artifact): string[] {
  const ids: string[] = [];
  for (const event of artifact.events) {
    if (event.body.kind !== "begin" || event.body.capture.kind !== "complete")
      continue;
    const command = reviewWorkflowCommandSchema.safeParse(
      event.body.capture.value,
    );
    if (!command.success || command.data.operation !== "submit") continue;
    // Malformed submissions may still declare a session. They cannot escape the cross-trial check.
    const response = command.data.response;
    if (response && typeof response === "object" && "host" in response) {
      const host = response.host;
      if (
        host &&
        typeof host === "object" &&
        "sessionId" in host &&
        typeof host.sessionId === "string"
      )
        ids.push(host.sessionId);
    }
  }
  return [...new Set(ids)];
}
function classification(artifact: Artifact): Intake["status"] {
  const summary = artifact.summary;
  if (summary.journalStatus !== "sealed") return "interrupted";
  return summary.workflows.length === 1 &&
    summary.workflows[0]!.disposition !== "not-complete" &&
    summary.allCommandBodiesRetained &&
    summary.nativeAccountingComplete &&
    summary.nativeReceipts.complete
    ? "sealed-completed"
    : "sealed-incomplete";
}
/** Private operator intake with a read-only worker view. Reopening never resumes reviewers. */
export class ReviewBenchmark {
  readonly #root: string;
  readonly #reference: ReviewBenchmarkReference;
  constructor(root: string, reference: ReviewBenchmarkReference) {
    this.#root = realpathSync(root);
    this.#reference = reviewBenchmarkReferenceSchema.parse(reference);
    this.#load();
  }
  #load() {
    const root = directory(this.#reference.directory);
    outside(this.#root, root);
    directory(path.join(root, "journals"));
    const bytes = readPrivate(path.join(root, "manifest.json"), MANIFEST_BYTES);
    if (sha(bytes) !== this.#reference.sha256)
      throw new Error("Benchmark frozen manifest digest disagrees");
    const manifest = checkedManifest(decode(bytes));
    if (manifest.plan.judging) directory(path.join(root, "judgments"));
    if (manifest.plan.multiScoring) directory(path.join(root, "mappings"));
    return { root, manifest };
  }
  #readJournal(root: string, trial: Trial): Buffer | null {
    const file = path.join(root, "journals", `${trial.trialId}.jsonl`);
    try {
      const stat = lstatSync(file);
      if (stat.size > JOURNAL_BYTES)
        throw new Error("Benchmark journal exceeds trial bound");
      return readReviewWorkflowAuditBytes(file, JOURNAL_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  #intakes(root: string, manifest: Manifest): Intake[] {
    const trials: Intake[] = [],
      sessions = new Map<string, Set<number>>();
    for (const trial of manifest.trials) {
      let raw: Buffer | null;
      try {
        raw = this.#readJournal(root, trial);
      } catch {
        trials.push({
          trialId: trial.trialId,
          status: "unavailable",
          journalDigest: null,
          journalBase64: null,
        });
        continue;
      }
      if (!raw) {
        trials.push({
          trialId: trial.trialId,
          status: "missing",
          journalDigest: null,
          journalBase64: null,
        });
        continue;
      }
      const intake: Intake = {
        trialId: trial.trialId,
        status: "invalid",
        journalDigest: sha(raw),
        journalBase64: raw.toString("base64"),
      };
      trials.push(intake);
      try {
        const artifact = parseReviewWorkflowAuditArtifact(raw);
        for (const id of declaredSessions(artifact)) {
          const indices = sessions.get(id) ?? new Set<number>();
          indices.add(trials.length - 1);
          sessions.set(id, indices);
        }
        intake.status = checkTrial(
          artifact,
          manifest,
          trial,
          this.#reference.sha256,
        )
          ? classification(artifact)
          : "foreign";
      } catch {
        /* Retain invalid bytes, never substitute a favorable retry. */
      }
    }
    for (const [id, indices] of sessions)
      if (id === manifest.plan.curatorSessionId || indices.size > 1)
        for (const index of indices) trials[index]!.status = "foreign";
    return trials;
  }
  #collection(root: string, manifest: Manifest) {
    const filename = path.join(root, "collection.json");
    let bytes: Buffer;
    try {
      bytes = readPrivate(filename, COLLECTION_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const collection = collectionSchema.parse(decode(bytes));
    if (
      collection.protocolDigest !== this.#reference.sha256 ||
      !equal(collection.trials, this.#intakes(root, manifest))
    )
      throw new Error("Benchmark collection or reached journals changed");
    return { collection, sha256: sha(bytes) };
  }
  #judging(
    manifest: Manifest,
    collected: { collection: z.infer<typeof collectionSchema>; sha256: string },
  ) {
    const packets = manifest.trials
      .map((trial, index) => {
        const intake = collected.collection.trials[index]!,
          outputs: unknown[] = [],
          native: unknown[] = [];
        if (
          intake.journalBase64 &&
          !["invalid", "foreign"].includes(intake.status)
        ) {
          const artifact = parseReviewWorkflowAuditArtifact(
            Buffer.from(intake.journalBase64, "base64"),
          );
          const begins = new Map(
            artifact.events.flatMap((e) =>
              e.body.kind === "begin"
                ? [[e.body.commandId, e.body] as const]
                : [],
            ),
          );
          for (const event of artifact.events) {
            if (event.body.kind !== "finish") continue;
            const begin = begins.get(event.body.commandId),
              command = reviewWorkflowCommandSchema.safeParse(
                begin?.capture.value,
              );
            if (
              event.body.outcome === "result" &&
              command.success &&
              command.data.operation === "submit"
            ) {
              const submission = command.data;
              const rawResponse = submission.response;
              const response =
                reviewWorkflowResponseSchema.safeParse(rawResponse);
              const before = begin?.states
                .find((w) => w.workflowId === submission.workflowId)
                ?.assignments.at(-1);
              const after = event.body.states
                .find((w) => w.workflowId === submission.workflowId)
                ?.assignments.at(-1);
              if (
                response.success &&
                response.data.output &&
                before?.status === "awaiting-host" &&
                after?.stage === "reviewer" &&
                after.status === "accepted" &&
                after.assignmentId === response.data.assignmentId &&
                after.assignmentDigest === response.data.assignmentDigest &&
                after.responseDigest === sha(JSON.stringify(rawResponse))
              ) {
                outputs.push(response.data.output);
              }
            }
            if ("nativeReceipt" in event.body && event.body.nativeReceipt) {
              const { candidate, recipe, run } = event.body.nativeReceipt;
              native.push({ candidate, recipe, run });
            }
          }
        }
        return {
          blindId: trial.blindId,
          status: intake.status,
          context: manifest.plan.cases[trial.caseIndex]!.context,
          outputs,
          native,
        };
      })
      .sort((a, b) => a.blindId.localeCompare(b.blindId));
    return reviewBenchmarkJudgingSchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      externalAttemptsComplete: false,
      format: "review-benchmark-judging",
      collectionDigest: collected.sha256,
      hostIsolationVerified: false,
      claimsVerified: false,
      qualityAssessed: false,
      packets,
    });
  }
  #judgeBook(root: string, manifest: Manifest) {
    if (!manifest.plan.judging)
      throw new Error("No judging profile was frozen");
    directory(path.join(root, "judgments"));
    const collected = this.#collection(root, manifest);
    if (!collected)
      throw new Error("All planned trials must be collected before judging");
    const bytes = readPrivate(
      path.join(root, "judging.json"),
      COLLECTION_BYTES,
    );
    const book = reviewBenchmarkJudgingSchema.parse(decode(bytes));
    if (!equal(book, this.#judging(manifest, collected)))
      throw new Error("Benchmark judging artifact disagrees");
    return { book, collected, judgingDigest: sha(bytes) };
  }
  #judgePacket(
    manifest: Manifest,
    book: z.infer<typeof reviewBenchmarkJudgingSchema>,
    blindId: string,
  ) {
    const rawEvidence = book.packets.find((p) => p.blindId === blindId);
    if (!rawEvidence || !manifest.plan.judging)
      throw new Error("Unknown benchmark judge slot");
    const evidence = {
      ...rawEvidence,
      outputs: rawEvidence.outputs.map((output) => ({
        ...output,
        candidates: output.candidates.map(
          projectReviewCandidateForIndependentStage,
        ),
      })),
      native: rawEvidence.native.map((observation) => ({
        candidate: projectReviewCandidateForIndependentStage(
          observation.candidate,
        ),
        observations: projectReviewNativeObservations(
          JSON.parse(observation.recipe.contents),
          observation.run,
        ),
      })),
    };
    const claims = rawEvidence.outputs.flatMap((output, outputIndex) =>
      output.candidates.map((candidate, candidateIndex) => ({
        claimId: sha(
          JSON.stringify({ blindId, outputIndex, candidateIndex, candidate }),
        ),
        candidate: projectReviewCandidateForIndependentStage(candidate),
      })),
    );
    const instructions = manifest.plan.judging.instructions;
    const assignmentDigest = sha(
      JSON.stringify({
        protocolDigest: this.#reference.sha256,
        collectionDigest: book.collectionDigest,
        instructions,
        evidence,
        claims,
      }),
    );
    const packet = reviewBenchmarkJudgePacketSchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-judge-packet",
      blindId,
      assignmentDigest,
      instructions,
      evidence,
      claims,
      sessionRequirement: "fresh-host-session",
      sourceTrust: "untrusted-source-and-review-text",
      sourceIncluded: true,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
    });
    if (Buffer.byteLength(JSON.stringify(packet)) > JUDGE_PACKET_BYTES)
      throw new Error(
        "Benchmark judge packet exceeds fixed source disclosure bound",
      );
    return packet;
  }
  #judgeIntakes(
    root: string,
    manifest: Manifest,
    book: z.infer<typeof reviewBenchmarkJudgingSchema>,
  ) {
    type Row = z.infer<
      typeof reviewBenchmarkJudgmentArchiveSchema
    >["judgments"][number];
    const rows: Row[] = [],
      sessions = new Map<string, Set<number>>();
    const forbidden = new Set([manifest.plan.curatorSessionId]);
    const collected = this.#collection(root, manifest)!;
    for (const trial of collected.collection.trials) {
      if (!trial.journalBase64) continue;
      try {
        for (const id of declaredSessions(
          parseReviewWorkflowAuditArtifact(
            Buffer.from(trial.journalBase64, "base64"),
          ),
        ))
          forbidden.add(id);
      } catch {
        /* Invalid reviewer evidence cannot supply an authenticated session inventory. */
      }
    }
    for (const evidence of book.packets) {
      const row: Row = {
        blindId: evidence.blindId,
        status: "invalid",
        responseDigest: null,
        responseBase64: null,
      };
      rows.push(row);
      let bytes: Buffer;
      try {
        bytes = readPrivate(
          path.join(root, "judgments", `${evidence.blindId}.json`),
          JUDGMENT_BYTES,
        );
      } catch (error) {
        row.status =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unavailable";
        continue;
      }
      row.responseDigest = sha(bytes);
      row.responseBase64 = bytes.toString("base64");
      let input: unknown;
      try {
        input = decode(bytes);
      } catch {
        continue;
      }
      // A malformed record can still declare an identity; do not exempt it from reuse checks.
      if (
        input &&
        typeof input === "object" &&
        "host" in input &&
        input.host &&
        typeof input.host === "object" &&
        "sessionId" in input.host &&
        typeof input.host.sessionId === "string"
      ) {
        const indices = sessions.get(input.host.sessionId) ?? new Set<number>();
        indices.add(rows.length - 1);
        sessions.set(input.host.sessionId, indices);
      }
      const parsed = reviewBenchmarkJudgmentResponseSchema.safeParse(input);
      if (!parsed.success) continue;
      const response = parsed.data,
        packet = this.#judgePacket(manifest, book, evidence.blindId);
      const isolation = response.host.isolation;
      const host = {
        client: response.host.client,
        clientVersion: response.host.clientVersion,
        provider: response.host.provider,
        model: response.host.model,
      };
      if (
        response.blindId !== packet.blindId ||
        response.assignmentDigest !== packet.assignmentDigest ||
        !equal(host, manifest.plan.judging!.host)
      ) {
        row.status = "foreign";
        continue;
      }
      if (response.status !== "completed") {
        row.status = response.output === null ? "incomplete" : "invalid";
        continue;
      }
      const output = response.output;
      if (!output) continue;
      const expected = new Set(packet.claims.map((c) => c.claimId));
      const citationsMatch = (citations: typeof output.citations) =>
        citations.every((c) => {
          const file = evidence.context.files.find((f) => f.path === c.file);
          if (
            !file ||
            c.revision !== "current" ||
            file.sha256 !== c.sourceDigest ||
            c.endLine < c.startLine
          )
            return false;
          const lines = file.content.split("\n");
          return (
            c.endLine <= lines.length &&
            lines
              .slice(c.startLine - 1, c.endLine)
              .join("\n")
              .includes(c.quote)
          );
        });
      if (
        !citationsMatch(output.citations) ||
        (output.label !== "unresolved" && !output.citations.length)
      )
        continue;
      let valid = true;
      for (const claim of output.claims) {
        if (
          !expected.delete(claim.claimId) ||
          !citationsMatch(claim.citations) ||
          (claim.judgement !== "unresolved" && !claim.citations.length) ||
          (claim.judgement === "supported" && output.label !== "defect")
        )
          valid = false;
      }
      if (!valid || expected.size) continue;
      // A judgment against unusable review evidence cannot become an accepted finding disposition.
      row.status =
        isolation === "fresh" && evidence.status === "sealed-completed"
          ? "accepted"
          : "incomplete";
    }
    for (const [id, indices] of sessions)
      if (forbidden.has(id) || indices.size > 1)
        for (const index of indices) rows[index]!.status = "foreign";
    return rows;
  }
  #judgmentArchive(root: string, manifest: Manifest) {
    let bytes: Buffer;
    try {
      bytes = readPrivate(
        path.join(root, "judgments-sealed.json"),
        JUDGMENT_ARCHIVE_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const archive = reviewBenchmarkJudgmentArchiveSchema.parse(decode(bytes));
    const { book, collected, judgingDigest } = this.#judgeBook(root, manifest);
    if (
      archive.protocolDigest !== this.#reference.sha256 ||
      archive.collectionDigest !== collected.sha256 ||
      archive.judgingDigest !== judgingDigest ||
      !equal(archive.judgments, this.#judgeIntakes(root, manifest, book))
    )
      throw new Error("Benchmark judgments or reached responses changed");
    const accepted = archive.judgments.filter((j) => j.status === "accepted");
    const resolved = accepted.filter((j) => {
      const output = reviewBenchmarkJudgmentResponseSchema.parse(
        decode(Buffer.from(j.responseBase64!, "base64")),
      ).output!;
      return (
        output.label !== "unresolved" &&
        output.claims.every((c) => c.judgement !== "unresolved")
      );
    }).length;
    return {
      archive,
      sha256: sha(bytes),
      summary: {
        planned: archive.judgments.length,
        accounted: archive.judgments.length,
        accepted: accepted.length,
        resolved,
        archiveDigest: sha(bytes),
      },
    };
  }
  /** Operator-only fixed response path; no model execution or host authentication. */
  judgeSetup(blindId: string) {
    const { root, manifest } = this.#load();
    if (this.#judgmentArchive(root, manifest))
      throw new Error("Benchmark judging is closed after sealing");
    const { book } = this.#judgeBook(root, manifest),
      packet = this.#judgePacket(manifest, book, blindId);
    return {
      file: path.join(root, "judgments", `${blindId}.json`),
      maxBytes: JUDGMENT_BYTES,
      maxPacketBytes: JUDGE_PACKET_BYTES,
      binding: { blindId, assignmentDigest: packet.assignmentDigest },
    };
  }
  /** One anonymous judge assignment with no curator answers or sibling outputs. */
  judgeWorkerCommand(input: unknown, allowSource: boolean, blindId: string) {
    const command = reviewBenchmarkWorkerCommandSchema.parse(input),
      { root, manifest } = this.#load();
    const { book } = this.#judgeBook(root, manifest),
      packet = this.#judgePacket(manifest, book, blindId);
    const archive = this.#judgmentArchive(root, manifest);
    if (command.operation === "packet") {
      if (!allowSource)
        throw new Error(
          "Benchmark source disclosure requires operator startup authorization",
        );
      if (archive) throw new Error("Benchmark judging is closed after sealing");
      return packet;
    }
    const row = archive?.archive.judgments.find((j) => j.blindId === blindId);
    return reviewBenchmarkJudgeWorkerSummarySchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-judge-worker-summary",
      blindId,
      state: archive ? "judgments-sealed" : "judging-prepared",
      status: row?.status ?? null,
      responseDigest: row?.responseDigest ?? null,
      sourceIncluded: false,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
    });
  }
  /** Seal every predeclared judgment path, including rejected or absent raw responses. */
  sealJudgments() {
    const { root, manifest } = this.#load(),
      { book, collected, judgingDigest } = this.#judgeBook(root, manifest);
    if (existsSync(path.join(root, "judgments-sealed.json")))
      throw new Error("Benchmark judgments already sealed");
    const judgments = this.#judgeIntakes(root, manifest, book);
    if (!equal(judgments, this.#judgeIntakes(root, manifest, book)))
      throw new Error("Benchmark judgments changed during sealing");
    writeNew(
      path.join(root, "judgments-sealed.json"),
      {
        schemaVersion: 1,
        protocolDigest: this.#reference.sha256,
        collectionDigest: collected.sha256,
        judgingDigest,
        createdAt: new Date().toISOString(),
        judgments,
      },
      JUDGMENT_ARCHIVE_BYTES,
    );
    return this.status();
  }
  /** Operator-only descriptive scoring from every sealed synthetic slot. */
  score(detailed = false) {
    const load = () => {
      const { root, manifest } = this.#load();
      if (!manifest.plan.scoring)
        throw new Error("Benchmark scoring must be declared before freezing");
      const judgments = this.#judgmentArchive(root, manifest);
      if (!judgments)
        throw new Error("Benchmark judgments must be sealed before scoring");
      const { book, collected, judgingDigest } = this.#judgeBook(
        root,
        manifest,
      );
      return { manifest, judgments, book, collected, judgingDigest };
    };
    const first = load();
    const { manifest, judgments, book, collected, judgingDigest } = first;
    const settings = manifest.plan.scoring!;
    const pairs = manifest.plan.cases.flatMap((c, caseIndex) =>
      Array.from({ length: manifest.plan.repetitions }, (_, repetition) => ({
        id: sha(
          JSON.stringify({ runId: manifest.runId, caseIndex, repetition }),
        ),
        clusterId: sha(
          JSON.stringify({ runId: manifest.runId, group: c.group }),
        ),
        family: settings.cases.find((s) => s.id === c.id)!.family,
        label:
          c.labels.variant === "broken"
            ? ("defect" as const)
            : c.labels.variant === "fixed"
              ? ("valid" as const)
              : ("near-miss" as const),
        caseIndex,
        repetition,
      })),
    );
    const observations: z.infer<
      typeof reviewPairedInputSchema
    >["observations"] = { a: [], b: [] };
    const accounting = {
      plannedTrials: manifest.trials.length,
      selectedPairs: pairs.length,
      completedTrials: 0,
      retainedClaims: 0,
      unscoredClaims: 0,
      missingJudgments: 0,
      rejectedJudgments: 0,
      unresolvedClaimJudgments: 0,
      labelDisagreements: 0,
      unknownJudgeLabels: 0,
      unexpectedFamilyClaims: 0,
      declaredClaimProbabilities: 0,
      unknownClaimProbabilities: 0,
    };
    for (const trial of manifest.trials) {
      const pair = pairs.find(
        (p) =>
          p.caseIndex === trial.caseIndex && p.repetition === trial.repetition,
      )!;
      const evidence = book.packets.find((p) => p.blindId === trial.blindId)!;
      const claims = this.#judgePacket(manifest, book, trial.blindId).claims;
      const intake = judgments.archive.judgments.find(
        (j) => j.blindId === trial.blindId,
      )!;
      accounting.retainedClaims += claims.length;
      if (intake.status === "missing") accounting.missingJudgments++;
      else if (intake.status !== "accepted") accounting.rejectedJudgments++;
      if (evidence.status !== "sealed-completed") {
        accounting.unscoredClaims += claims.length;
        // Missing slots remain genuinely absent; the paired scorer preserves their known labels.
        if (evidence.status !== "missing")
          observations[trial.armIndex === 0 ? "a" : "b"].push({
            id: pair.id,
            status: "incomplete",
            decision: "abstain",
            probability: null,
            judgement: "none",
          });
        continue;
      }
      accounting.completedTrials++;
      if (evidence.outputs.length !== 1 || claims.length > 1)
        throw new Error(
          "Benchmark scoring profile requires one completed reviewer output with at most one claim; no partial score is returned",
        );
      const claim = claims[0];
      // The raw sealed reviewer candidate supplies its own prediction. Judge
      // outputs, severity, counterclaims and numerical fit artifacts cannot replace it.
      const probability = claim
        ? (evidence.outputs[0]!.candidates[0]!.confidence?.probability ?? null)
        : null;
      if (claim) {
        if (probability === null) accounting.unknownClaimProbabilities++;
        else accounting.declaredClaimProbabilities++;
      }
      const response =
        intake.status === "accepted"
          ? reviewBenchmarkJudgmentResponseSchema.parse(
              decode(Buffer.from(intake.responseBase64!, "base64")),
            ).output!
          : null;
      if (response?.label === "unresolved") accounting.unknownJudgeLabels++;
      else if (response && response.label !== pair.label)
        accounting.labelDisagreements++;
      if (claim && claim.candidate.family !== pair.family)
        accounting.unexpectedFamilyClaims++;
      const judgement = !claim
        ? ("none" as const)
        : response &&
            response.label === pair.label &&
            claim.candidate.family === pair.family
          ? response.claims.find((c) => c.claimId === claim.claimId)!.judgement
          : ("unresolved" as const);
      if (judgement === "unresolved") accounting.unresolvedClaimJudgments++;
      observations[trial.armIndex === 0 ? "a" : "b"].push({
        id: pair.id,
        status: "completed",
        decision: claim ? "finding" : "abstain",
        probability,
        judgement,
      });
    }
    const paired = scorePairedReviewTrials({
      protocol: {
        schemaVersion: 1,
        profile: "declared-paired-cluster-v1",
        purpose: "development",
        seed: settings.seed,
        resamples: settings.resamples,
        confidenceLevel: settings.confidenceLevel,
        trials: pairs.map(({ id, clusterId, family }) => ({
          id,
          clusterId,
          family,
        })),
      },
      labels: pairs.map(({ id, label }) => ({ id, label })),
      observations,
    });
    const report = reviewBenchmarkScoreReportSchema.parse({
      schemaVersion: 1,
      format: "review-benchmark-scoring-report",
      profile: settings.profile,
      protocolDigest: this.#reference.sha256,
      collectionDigest: collected.sha256,
      judgingDigest,
      judgmentsDigest: judgments.sha256,
      scoringParametersDigest: sha(JSON.stringify(settings)),
      armDigests: manifest.plan.arms.map((arm) => sha(JSON.stringify(arm))),
      accounting,
      scoringReady:
        accounting.completedTrials === accounting.plannedTrials &&
        accounting.missingJudgments === 0 &&
        accounting.rejectedJudgments === 0 &&
        accounting.unresolvedClaimJudgments === 0 &&
        accounting.labelDisagreements === 0 &&
        accounting.unknownJudgeLabels === 0 &&
        accounting.unexpectedFamilyClaims === 0,
      artifactBindingsChecked: true,
      pairingBoundToManifest: true,
      labelSource: "frozen-declared-synthetic-case-variants",
      probabilitiesAvailable: accounting.declaredClaimProbabilities > 0,
      probabilitySource: "sealed-host-declared-uncalibrated-claim-probability",
      sourceIncluded: false,
      claimsVerified: false,
      labelsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      calibratedConfidence: false,
      qualityAssessed: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      paired,
    });
    if (!equal(first, load()))
      throw new Error("Benchmark scoring artifacts changed during computation");
    return detailed
      ? report
      : reviewBenchmarkScoreSummarySchema.parse({
          ...report,
          format: "review-benchmark-scoring-summary",
          paired: projectPairedReviewScoring(report.paired, false),
        });
  }
  #commonDefects(manifest: Manifest, trial: Trial) {
    const c = manifest.plan.cases[trial.caseIndex]!;
    const declared = manifest.plan.multiScoring!.cases.find(
      (r) => r.id === c.id,
    )!;
    return declared.defects.map((d) => ({
      id: sha(
        JSON.stringify({
          runId: manifest.runId,
          caseIndex: trial.caseIndex,
          defect: d.id,
        }),
      ),
      family: d.family,
      material: d.material,
      claim: c.labels.expectedDefects.find((e) => e.id === d.id)!.claim,
    }));
  }
  #matchingPacket(
    manifest: Manifest,
    book: z.infer<typeof reviewBenchmarkJudgingSchema>,
    judgmentsDigest: string,
    trial: Trial,
  ) {
    if (!manifest.plan.multiScoring || !trial.matchingId)
      throw new Error("No frozen multi-claim matching profile");
    const judged = this.#judgePacket(manifest, book, trial.blindId);
    const payload = {
      matchingId: trial.matchingId,
      instructions: manifest.plan.multiScoring.matching.instructions,
      context: manifest.plan.cases[trial.caseIndex]!.context,
      claims: judged.claims,
      defects: this.#commonDefects(manifest, trial).map(
        ({ id, family, claim }) => ({ id, family, claim }),
      ),
    };
    const assignmentDigest = sha(
      JSON.stringify({
        protocolDigest: this.#reference.sha256,
        collectionDigest: book.collectionDigest,
        judgmentsDigest,
        payload,
      }),
    );
    const packet = reviewBenchmarkMatchingPacketSchema.parse({
      ...payload,
      assignmentDigest,
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-matching-packet",
      sessionRequirement: "fresh-host-session",
      sourceTrust: "untrusted-source-and-review-text",
      sourceIncluded: true,
      expectedInventoryIncluded: true,
      priorVerdictsIncluded: false,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
    });
    if (Buffer.byteLength(JSON.stringify(packet)) > JUDGE_PACKET_BYTES)
      throw new Error("Benchmark matching packet exceeds bound");
    return packet;
  }
  #expectedMatchingBook(root: string, manifest: Manifest) {
    if (!manifest.plan.multiScoring)
      throw new Error("No frozen multi-claim matching profile");
    const judgments = this.#judgmentArchive(root, manifest);
    if (!judgments)
      throw new Error("Independent judgments must be sealed before matching");
    const { book, collected, judgingDigest } = this.#judgeBook(root, manifest);
    const expected = reviewBenchmarkMatchingBookSchema.parse({
      schemaVersion: 1,
      protocolDigest: this.#reference.sha256,
      collectionDigest: collected.sha256,
      judgingDigest,
      judgmentsDigest: judgments.sha256,
      slots: manifest.trials
        .map((trial) => {
          const packet = this.#matchingPacket(
            manifest,
            book,
            judgments.sha256,
            trial,
          );
          return {
            matchingId: packet.matchingId,
            assignmentDigest: packet.assignmentDigest,
          };
        })
        .sort((a, b) => a.matchingId.localeCompare(b.matchingId)),
    });
    return { expected, book, collected, judgments, judgingDigest };
  }
  #matchingBook(root: string, manifest: Manifest) {
    const inputs = this.#expectedMatchingBook(root, manifest);
    const bytes = readPrivate(
      path.join(root, "matching.json"),
      JUDGE_PACKET_BYTES,
    );
    const matching = reviewBenchmarkMatchingBookSchema.parse(decode(bytes));
    if (!equal(matching, inputs.expected))
      throw new Error("Benchmark matching artifact disagrees");
    return { ...inputs, matching, matchingDigest: sha(bytes) };
  }
  #mappingIntakes(
    root: string,
    manifest: Manifest,
    book: z.infer<typeof reviewBenchmarkJudgingSchema>,
    judgments: z.infer<typeof reviewBenchmarkJudgmentArchiveSchema>,
    matching: z.infer<typeof reviewBenchmarkMatchingBookSchema>,
  ) {
    type Row = z.infer<
      typeof reviewBenchmarkMappingArchiveSchema
    >["mappings"][number];
    const rows: Row[] = [],
      sessions = new Map<string, Set<number>>(),
      forbidden = new Set([manifest.plan.curatorSessionId]);
    const collected = this.#collection(root, manifest)!;
    for (const row of collected.collection.trials) {
      if (!row.journalBase64) continue;
      try {
        for (const id of declaredSessions(
          parseReviewWorkflowAuditArtifact(
            Buffer.from(row.journalBase64, "base64"),
          ),
        ))
          forbidden.add(id);
      } catch {
        /* Retain malformed raw evidence. */
      }
    }
    for (const row of judgments.judgments) {
      if (!row.responseBase64) continue;
      try {
        const raw = decode(Buffer.from(row.responseBase64, "base64"));
        if (
          raw &&
          typeof raw === "object" &&
          "host" in raw &&
          raw.host &&
          typeof raw.host === "object" &&
          "sessionId" in raw.host &&
          typeof raw.host.sessionId === "string"
        )
          forbidden.add(raw.host.sessionId);
      } catch {
        /* A malformed judgment does not disappear from its archive. */
      }
    }
    for (const slot of matching.slots) {
      const row: Row = {
        matchingId: slot.matchingId,
        status: "invalid",
        responseDigest: null,
        responseBase64: null,
      };
      rows.push(row);
      let bytes: Buffer;
      try {
        bytes = readPrivate(
          path.join(root, "mappings", `${slot.matchingId}.json`),
          JUDGMENT_BYTES,
        );
      } catch (error) {
        row.status =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unavailable";
        continue;
      }
      row.responseDigest = sha(bytes);
      row.responseBase64 = bytes.toString("base64");
      let raw: unknown;
      try {
        raw = decode(bytes);
      } catch {
        continue;
      }
      if (
        raw &&
        typeof raw === "object" &&
        "host" in raw &&
        raw.host &&
        typeof raw.host === "object" &&
        "sessionId" in raw.host &&
        typeof raw.host.sessionId === "string"
      ) {
        const indices = sessions.get(raw.host.sessionId) ?? new Set<number>();
        indices.add(rows.length - 1);
        sessions.set(raw.host.sessionId, indices);
      }
      const parsed = reviewBenchmarkMatchingResponseSchema.safeParse(raw);
      if (!parsed.success) continue;
      const response = parsed.data,
        trial = manifest.trials.find((t) => t.matchingId === slot.matchingId)!;
      const packet = this.#matchingPacket(
        manifest,
        book,
        matching.judgmentsDigest,
        trial,
      );
      const { client, clientVersion, provider, model } = response.host;
      if (
        response.matchingId !== packet.matchingId ||
        response.assignmentDigest !== packet.assignmentDigest ||
        !equal(
          { client, clientVersion, provider, model },
          manifest.plan.multiScoring!.matching.host,
        )
      ) {
        row.status = "foreign";
        continue;
      }
      if (response.status !== "completed") {
        row.status = response.output === null ? "incomplete" : "invalid";
        continue;
      }
      if (!response.output) continue;
      const claims = new Map(packet.claims.map((c) => [c.claimId, c])),
        expected = new Set(claims.keys());
      let valid = true;
      for (const mapped of response.output) {
        const candidate = claims.get(mapped.claimId)?.candidate;
        if (
          !expected.delete(mapped.claimId) ||
          !candidate ||
          (mapped.match === "defect") !== (mapped.defectId !== null) ||
          (mapped.defectId !== null &&
            !packet.defects.some(
              (d) => d.id === mapped.defectId && d.family === candidate.family,
            )) ||
          (mapped.match !== "unresolved" && !mapped.citations.length) ||
          !mapped.citations.every((c) => {
            const file = packet.context.files.find((f) => f.path === c.file);
            return (
              file &&
              c.revision === "current" &&
              file.sha256 === c.sourceDigest &&
              c.endLine >= c.startLine &&
              c.endLine <= file.content.split("\n").length &&
              file.content
                .split("\n")
                .slice(c.startLine - 1, c.endLine)
                .join("\n")
                .includes(c.quote)
            );
          })
        )
          valid = false;
      }
      if (!valid || expected.size) continue;
      row.status =
        response.host.isolation === "fresh" &&
        book.packets.find((p) => p.blindId === trial.blindId)!.status ===
          "sealed-completed"
          ? "accepted"
          : "incomplete";
    }
    for (const [id, indices] of sessions)
      if (forbidden.has(id) || indices.size > 1)
        for (const i of indices) rows[i]!.status = "foreign";
    return rows;
  }
  #mappingArchive(root: string, manifest: Manifest) {
    let bytes: Buffer;
    try {
      bytes = readPrivate(
        path.join(root, "mappings-sealed.json"),
        JUDGMENT_ARCHIVE_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const archive = reviewBenchmarkMappingArchiveSchema.parse(decode(bytes)),
      inputs = this.#matchingBook(root, manifest);
    const binding = matchingBinding(inputs.matching);
    if (
      archive.matchingDigest !== inputs.matchingDigest ||
      !equal(binding, {
        schemaVersion: archive.schemaVersion,
        protocolDigest: archive.protocolDigest,
        collectionDigest: archive.collectionDigest,
        judgingDigest: archive.judgingDigest,
        judgmentsDigest: archive.judgmentsDigest,
      }) ||
      !equal(
        archive.mappings,
        this.#mappingIntakes(
          root,
          manifest,
          inputs.book,
          inputs.judgments.archive,
          inputs.matching,
        ),
      )
    )
      throw new Error("Benchmark mappings or reached responses changed");
    const accepted = archive.mappings.filter((m) => m.status === "accepted");
    return {
      archive,
      sha256: sha(bytes),
      matchingDigest: inputs.matchingDigest,
      summary: {
        planned: archive.mappings.length,
        accounted: archive.mappings.length,
        accepted: accepted.length,
        resolved: accepted.filter((m) =>
          reviewBenchmarkMatchingResponseSchema
            .parse(decode(Buffer.from(m.responseBase64!, "base64")))
            .output!.every((c) => c.match !== "unresolved"),
        ).length,
        archiveDigest: sha(bytes),
      },
    };
  }
  /** Freeze anonymous curation assignments only after independent judgments are sealed. */
  prepareMatching() {
    const { root, manifest } = this.#load(),
      { expected } = this.#expectedMatchingBook(root, manifest);
    writeNew(path.join(root, "matching.json"), expected, JUDGE_PACKET_BYTES);
    return this.status();
  }
  matcherSetup(matchingId: string) {
    const { root, manifest } = this.#load(),
      inputs = this.#matchingBook(root, manifest);
    if (this.#mappingArchive(root, manifest))
      throw new Error("Benchmark matching is closed after sealing");
    const trial = manifest.trials.find((t) => t.matchingId === matchingId);
    if (!trial) throw new Error("Unknown matching slot");
    const packet = this.#matchingPacket(
      manifest,
      inputs.book,
      inputs.matching.judgmentsDigest,
      trial,
    );
    return {
      file: path.join(root, "mappings", `${matchingId}.json`),
      maxBytes: JUDGMENT_BYTES,
      maxPacketBytes: JUDGE_PACKET_BYTES,
      binding: { matchingId, assignmentDigest: packet.assignmentDigest },
    };
  }
  matcherWorkerCommand(
    input: unknown,
    allowSource: boolean,
    matchingId: string,
  ) {
    const command = reviewBenchmarkWorkerCommandSchema.parse(input),
      { root, manifest } = this.#load(),
      inputs = this.#matchingBook(root, manifest);
    const trial = manifest.trials.find((t) => t.matchingId === matchingId);
    if (!trial) throw new Error("Unknown matching slot");
    const archive = this.#mappingArchive(root, manifest);
    if (command.operation === "packet") {
      if (!allowSource)
        throw new Error(
          "Benchmark source disclosure requires operator startup authorization",
        );
      if (archive)
        throw new Error("Benchmark matching is closed after sealing");
      return this.#matchingPacket(
        manifest,
        inputs.book,
        inputs.matching.judgmentsDigest,
        trial,
      );
    }
    const row = archive?.archive.mappings.find(
      (m) => m.matchingId === matchingId,
    );
    return reviewBenchmarkMatchingWorkerSummarySchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-matching-worker-summary",
      matchingId,
      state: archive ? "mappings-sealed" : "matching-prepared",
      status: row?.status ?? null,
      responseDigest: row?.responseDigest ?? null,
      sourceIncluded: false,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
    });
  }
  sealMappings() {
    const { root, manifest } = this.#load(),
      inputs = this.#matchingBook(root, manifest);
    if (existsSync(path.join(root, "mappings-sealed.json")))
      throw new Error("Benchmark mappings already sealed");
    const mappings = this.#mappingIntakes(
      root,
      manifest,
      inputs.book,
      inputs.judgments.archive,
      inputs.matching,
    );
    if (
      !equal(
        mappings,
        this.#mappingIntakes(
          root,
          manifest,
          inputs.book,
          inputs.judgments.archive,
          inputs.matching,
        ),
      )
    )
      throw new Error("Benchmark mappings changed during sealing");
    const binding = matchingBinding(inputs.matching);
    writeNew(
      path.join(root, "mappings-sealed.json"),
      {
        ...binding,
        matchingDigest: inputs.matchingDigest,
        createdAt: new Date().toISOString(),
        mappings,
      },
      JUDGMENT_ARCHIVE_BYTES,
    );
    return this.status();
  }
  /** Operator-only multi-claim scoring; every submitted claim and frozen slot remains. */
  scoreMulti(detailed = false) {
    const load = () => {
      const { root, manifest } = this.#load();
      if (!manifest.plan.multiScoring)
        throw new Error("Multi-claim scoring must be frozen before review");
      const mappings = this.#mappingArchive(root, manifest);
      if (!mappings)
        throw new Error(
          "Benchmark mappings must be sealed before multi-claim scoring",
        );
      return { manifest, mappings, ...this.#matchingBook(root, manifest) };
    };
    const first = load(),
      {
        manifest,
        mappings,
        book,
        collected,
        judgments,
        judgingDigest,
        matchingDigest,
      } = first,
      settings = manifest.plan.multiScoring!;
    const pairs = manifest.plan.cases.flatMap((c, caseIndex) =>
      Array.from({ length: manifest.plan.repetitions }, (_, repetition) => ({
        id: sha(
          JSON.stringify({ runId: manifest.runId, caseIndex, repetition }),
        ),
        clusterId: sha(
          JSON.stringify({ runId: manifest.runId, group: c.group }),
        ),
        caseIndex,
        repetition,
        label:
          c.labels.variant === "broken"
            ? ("defect" as const)
            : c.labels.variant === "fixed"
              ? ("valid" as const)
              : ("near-miss" as const),
      })),
    );
    const observations: z.infer<typeof reviewMultiInputSchema>["observations"] =
      { a: [], b: [] };
    const accounting = {
      plannedTrials: manifest.trials.length,
      selectedPairs: pairs.length,
      completedTrials: 0,
      retainedClaims: 0,
      unscoredClaims: 0,
      missingJudgments: 0,
      rejectedJudgments: 0,
      missingMappings: 0,
      rejectedMappings: 0,
      unresolvedClaims: 0,
      labelDisagreements: 0,
    };
    for (const trial of manifest.trials) {
      const pair = pairs.find(
          (p) =>
            p.caseIndex === trial.caseIndex &&
            p.repetition === trial.repetition,
        )!,
        evidence = book.packets.find((p) => p.blindId === trial.blindId)!;
      const claims = this.#judgePacket(manifest, book, trial.blindId).claims;
      const judged = judgments.archive.judgments.find(
          (j) => j.blindId === trial.blindId,
        )!,
        mapped = mappings.archive.mappings.find(
          (m) => m.matchingId === trial.matchingId,
        )!;
      if (judged.status === "missing") accounting.missingJudgments++;
      else if (judged.status !== "accepted") accounting.rejectedJudgments++;
      if (mapped.status === "missing") accounting.missingMappings++;
      else if (mapped.status !== "accepted") accounting.rejectedMappings++;
      accounting.retainedClaims += claims.length;
      if (evidence.status === "missing") continue;
      const completed = evidence.status === "sealed-completed";
      if (completed) accounting.completedTrials++;
      else accounting.unscoredClaims += claims.length;
      const judgment =
        judged.status === "accepted"
          ? reviewBenchmarkJudgmentResponseSchema.parse(
              decode(Buffer.from(judged.responseBase64!, "base64")),
            ).output!
          : null;
      const matches =
        mapped.status === "accepted"
          ? reviewBenchmarkMatchingResponseSchema.parse(
              decode(Buffer.from(mapped.responseBase64!, "base64")),
            ).output!
          : null;
      if (judgment && judgment.label !== pair.label)
        accounting.labelDisagreements++;
      const rawCandidates = evidence.outputs.flatMap((o) => o.candidates);
      observations[trial.armIndex === 0 ? "a" : "b"].push({
        id: pair.id,
        status: completed ? "completed" : "incomplete",
        claims: claims.map((claim, i) => {
          let judgement: z.infer<
            typeof reviewMultiInputSchema
          >["observations"]["a"][number]["claims"][number]["judgement"] =
            "unresolved";
          let defectId: string | null = null;
          if (completed && judgment?.label === pair.label) {
            const disposition = judgment.claims.find(
              (c) => c.claimId === claim.claimId,
            )!.judgement;
            const match = matches?.find((c) => c.claimId === claim.claimId);
            if (disposition !== "supported") judgement = disposition;
            else if (
              match?.match === "defect" &&
              this.#commonDefects(manifest, trial).some(
                (d) =>
                  d.id === match.defectId &&
                  d.family === claim.candidate.family,
              )
            ) {
              judgement = "supported";
              defectId = match.defectId;
            }
          }
          if (completed && judgement === "unresolved")
            accounting.unresolvedClaims++;
          return {
            id: claim.claimId,
            family: claim.candidate.family,
            judgement,
            defectId,
            probability: rawCandidates[i]!.confidence?.probability ?? null,
          };
        }),
      });
    }
    const multi = scoreMultiClaimReviewTrials({
      protocol: {
        schemaVersion: 1,
        profile: "declared-multi-claim-paired-v1",
        purpose: "development",
        seed: settings.seed,
        resamples: settings.resamples,
        confidenceLevel: settings.confidenceLevel,
        trials: pairs.map(({ id, clusterId }) => ({ id, clusterId })),
      },
      labels: pairs.map(({ id, label, caseIndex }) => ({
        id,
        label,
        defects: this.#commonDefects(
          manifest,
          manifest.trials.find((t) => t.caseIndex === caseIndex)!,
        ).map(({ id, family, material }) => ({ id, family, material })),
      })),
      observations,
    });
    const report = reviewBenchmarkMultiScoreReportSchema.parse({
      schemaVersion: 1,
      format: "review-benchmark-multi-scoring-report",
      profile: settings.profile,
      protocolDigest: this.#reference.sha256,
      collectionDigest: collected.sha256,
      judgingDigest,
      judgmentsDigest: judgments.sha256,
      matchingDigest,
      mappingsDigest: mappings.sha256,
      scoringParametersDigest: sha(JSON.stringify(settings)),
      armDigests: manifest.plan.arms.map((a) => sha(JSON.stringify(a))),
      accounting,
      scoringReady:
        accounting.completedTrials === accounting.plannedTrials &&
        accounting.missingJudgments === 0 &&
        accounting.rejectedJudgments === 0 &&
        accounting.missingMappings === 0 &&
        accounting.rejectedMappings === 0 &&
        accounting.unresolvedClaims === 0 &&
        accounting.labelDisagreements === 0,
      artifactBindingsChecked: true,
      pairingBoundToManifest: true,
      labelSource: "frozen-declared-synthetic-defect-inventory",
      probabilitySource: "sealed-host-declared-uncalibrated-claim-probability",
      sourceIncluded: false,
      claimsVerified: false,
      labelsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      calibratedConfidence: false,
      qualityAssessed: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
      multi,
    });
    if (!equal(first, load()))
      throw new Error(
        "Benchmark multi-claim artifacts changed during computation",
      );
    return detailed
      ? report
      : reviewBenchmarkMultiScoreSummarySchema.parse({
          ...report,
          format: "review-benchmark-multi-scoring-summary",
          multi: projectMultiClaimReviewScoring(report.multi, false),
        });
  }
  status() {
    const { root, manifest } = this.#load(),
      collected = this.#collection(root, manifest);
    const rows =
      collected?.collection.trials ??
      manifest.trials.map((t) => ({
        trialId: t.trialId,
        status: "uncollected" as const,
        journalDigest: null,
        journalBase64: null,
      }));
    let judging = false;
    if (collected) {
      try {
        const book = reviewBenchmarkJudgingSchema.parse(
          decode(
            readPrivate(path.join(root, "judging.json"), COLLECTION_BYTES),
          ),
        );
        if (!equal(book, this.#judging(manifest, collected)))
          throw new Error("Benchmark judging artifact disagrees");
        judging = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const judgments = this.#judgmentArchive(root, manifest);
    const mappings = manifest.plan.multiScoring
      ? this.#mappingArchive(root, manifest)
      : null;
    let matchingPrepared = false;
    if (
      manifest.plan.multiScoring &&
      existsSync(path.join(root, "matching.json"))
    ) {
      this.#matchingBook(root, manifest);
      matchingPrepared = true;
    }
    return reviewBenchmarkSummarySchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-summary",
      runId: manifest.runId,
      protocolDigest: this.#reference.sha256,
      judgments: judgments?.summary ?? null,
      ...(manifest.plan.multiScoring
        ? { mappings: mappings?.summary ?? null }
        : {}),
      state: mappings
        ? "mappings-sealed"
        : matchingPrepared
          ? "matching-prepared"
          : judgments
            ? "judgments-sealed"
            : collected
              ? judging
                ? "judging-prepared"
                : "collected"
              : "frozen",
      planned: rows.length,
      accounted: collected ? rows.length : 0,
      completed: rows.filter((r) => r.status === "sealed-completed").length,
      collectionDigest: collected?.sha256 ?? null,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
      sourceIncluded: false,
      trials: rows.map((r) => {
        let artifact: Artifact | undefined;
        try {
          if (r.journalBase64)
            artifact = parseReviewWorkflowAuditArtifact(
              Buffer.from(r.journalBase64, "base64"),
            );
        } catch {
          /* Invalid evidence has unknown counts. */
        }
        return {
          trialId: r.trialId,
          status: r.status,
          journalDigest: r.journalDigest,
          commands: artifact?.summary.commands.started ?? null,
          pendingCommands: artifact?.summary.commands.pending ?? null,
        };
      }),
    });
  }
  command(input: unknown, allowSource: boolean) {
    const command = reviewBenchmarkCommandSchema.parse(input);
    if (command.operation === "status") return this.status();
    if (!allowSource)
      throw new Error(
        "Benchmark source disclosure requires operator startup authorization",
      );
    const { manifest, root } = this.#load();
    if (this.#collection(root, manifest))
      throw new Error("Benchmark worker packets are closed after collection");
    const trial = manifest.trials.find((t) => t.trialId === command.trialId);
    if (!trial) throw new Error("Unknown benchmark trial");
    return reviewBenchmarkPacketSchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-packet",
      trialId: trial.trialId,
      instructions: manifest.plan.arms[trial.armIndex]!.instructions,
      context: manifest.plan.cases[trial.caseIndex]!.context,
      sessionRequirement: "fresh-host-session",
      sourceTrust: "untrusted-source-text",
      sourceIncluded: true,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
    });
  }
  /** One startup-selected worker trial; sibling handles and outputs are never returned. */
  workerCommand(input: unknown, allowSource: boolean, trialId: string) {
    const command = reviewBenchmarkWorkerCommandSchema.parse(input);
    const status = this.status(),
      trial = status.trials.find((t) => t.trialId === trialId);
    if (!trial) throw new Error("Unknown startup benchmark trial");
    if (command.operation === "packet")
      return this.command({ operation: "packet", trialId }, allowSource);
    return reviewBenchmarkWorkerSummarySchema.parse({
      schemaVersion: status.schemaVersion,
      profile: status.profile,
      format: "review-benchmark-worker-summary",
      protocolDigest: status.protocolDigest,
      state: status.state,
      trial,
      claimsVerified: false,
      hostIsolationVerified: false,
      externalAttemptsComplete: false,
      qualityAssessed: false,
      sourceIncluded: false,
    });
  }
  /** Operator-only: predeclared path and binding for a fresh workflow process. */
  trialSetup(trialId: string) {
    const { root, manifest } = this.#load(),
      trial = manifest.trials.find((t) => t.trialId === trialId);
    if (!trial || this.#collection(root, manifest))
      throw new Error("Benchmark trial is unavailable");
    return {
      audit: {
        file: path.join(root, "journals", `${trial.trialId}.jsonl`),
        maxBytes: JOURNAL_BYTES,
        maxEvents: 256,
        binding: binding(manifest, trial, this.#reference.sha256),
      },
      settings: structuredClone(manifest.plan.arms[trial.armIndex]!.settings),
    };
  }
  /** Finalize all planned slots at once, including missing/invalid/interrupted outputs. */
  collect() {
    const { root, manifest } = this.#load();
    if (existsSync(path.join(root, "collection.json")))
      throw new Error("Benchmark collection already exists");
    const trials = this.#intakes(root, manifest);
    // Nothing is written until every captured path is checked a second time.
    if (!equal(trials, this.#intakes(root, manifest)))
      throw new Error("Benchmark journals changed during collection");
    writeNew(
      path.join(root, "collection.json"),
      {
        schemaVersion: 1,
        protocolDigest: this.#reference.sha256,
        createdAt: new Date().toISOString(),
        trials,
      },
      COLLECTION_BYTES,
    );
    return this.status();
  }
  /** Anonymous judging packets; answer labels stay in the operator manifest. */
  prepareJudging() {
    const { root, manifest } = this.#load(),
      collected = this.#collection(root, manifest);
    if (!collected)
      throw new Error("All planned trials must be collected before judging");
    writeNew(
      path.join(root, "judging.json"),
      this.#judging(manifest, collected),
      COLLECTION_BYTES,
    );
    return this.status();
  }
}

/** Private operator JSON, never addressable by a benchmark tool argument. */
export function readReviewBenchmarkOperatorInput(filename: string): unknown {
  directory(path.dirname(filename));
  return decode(readPrivate(filename, MANIFEST_BYTES));
}
export function parseReviewBenchmarkReference(
  text: string,
): ReviewBenchmarkReference {
  const match = /^(.*)#sha256=([a-f0-9]{64})$/.exec(text);
  if (!match)
    throw new Error(
      "Benchmark reference requires an absolute directory and SHA-256 pin",
    );
  return reviewBenchmarkReferenceSchema.parse({
    directory: match[1],
    sha256: match[2],
  });
}
