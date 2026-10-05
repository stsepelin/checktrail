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
  reviewWorkflowLimitsSchema,
  reviewWorkflowResponseSchema,
  reviewWorkflowCommandSchema,
} from "./review-workflow-schema.js";
import {
  reviewBenchmarkPlanSchema,
  reviewBenchmarkReferenceSchema,
  reviewBenchmarkCommandSchema,
  reviewBenchmarkSummarySchema,
  reviewBenchmarkPacketSchema,
  reviewBenchmarkJudgingSchema,
  reviewBenchmarkWorkerCommandSchema,
  reviewBenchmarkWorkerSummarySchema,
  type ReviewBenchmarkReference,
} from "./review-benchmark-schema.js";
const MANIFEST_BYTES = 16_777_216;
const JOURNAL_BYTES = 4_194_304;
const COLLECTION_BYTES = 134_217_728;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const trialSchema = z.strictObject({
  trialId: z.string().uuid(),
  blindId: z.string().uuid(),
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
  for (const arm of plan.arms) {
    const limits = reviewWorkflowLimitsSchema.parse(
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
    return { root, manifest: checkedManifest(decode(bytes)) };
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
    return reviewBenchmarkSummarySchema.parse({
      schemaVersion: 1,
      profile: manifest.plan.profile,
      format: "review-benchmark-summary",
      runId: manifest.runId,
      protocolDigest: this.#reference.sha256,
      state: collected
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
