import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  fstatSync,
  realpathSync,
  writeSync,
  fsyncSync,
  readSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { observeReviewEngineDigest } from "./review-engine-identity.js";
import { VERSION } from "./types.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
  reviewWorkflowCommandSchema,
  reviewWorkflowResponseSchema,
  reviewWorkflowNativeReceiptSchema,
  type ReviewWorkflowNativeReceipt,
} from "./review-workflow-schema.js";
import {
  parseReviewProbe,
  parseReviewProbeRun,
  reviewProbeInputScale,
} from "./review-probe.js";
import type { ReviewWorkflowOptions } from "./review-workflow.js";
import {
  reviewWorkflowAuditOptionsSchema,
  reviewWorkflowAuditBindingSchema,
  reviewWorkflowAuditSummarySchema,
  type ReviewWorkflowAuditOptions,
  type ReviewWorkflowAuditSummary,
} from "./review-workflow-audit-schema.js";
const RECORD_BYTES = 2097152;
const END_BYTES = 524288;
const COMMAND_BYTES = 1048576;
const MAX_BYTES = 134217728;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const states = z.array(reviewWorkflowSummarySchema).max(16);
const operation = z.enum([
  "open",
  "next",
  "submit",
  "probe",
  "status",
  "close",
  "invalid",
]);
const captureSchema = z.strictObject({
  kind: z.enum(["complete", "prefix", "unserializable"]),
  bytes: count.nullable(),
  sha256: digest.nullable(),
  value: z.unknown(),
  prefixBase64: z.string().max(8192).nullable(),
  untrustedData: z.literal(true),
});
type Capture = z.infer<typeof captureSchema>;
export const reviewWorkflowAuditSettingsSchema = z.strictObject({
  allowReviewSource: z.literal(true),
  trusted: z.boolean(),
  workflowLimits: z.record(z.string(), z.number()).nullable(),
  nativeWallMs: count,
  maxNativeOutputBytes: count,
  nativeBudget: z.strictObject({ maxCalls: count, maxOutputBytes: count }),
  probes: z
    .array(z.strictObject({ id: z.string().min(1).max(64), sha256: digest }))
    .max(8),
});
const legacyBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("header"),
    engineVersion: z.string().min(1).max(128),
    engineRuntimeDigest: digest.optional(),
    runtime: z.strictObject({
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    rootDigest: digest,
    binding: reviewWorkflowAuditBindingSchema.optional(),
    maxBytes: count,
    maxEvents: count,
    settings: reviewWorkflowAuditSettingsSchema,
  }),
  z.strictObject({
    kind: z.literal("begin"),
    commandId: z.string().uuid(),
    operation,
    capture: captureSchema,
    states,
  }),
  z.strictObject({
    kind: z.literal("finish"),
    commandId: z.string().uuid(),
    outcome: z.enum(["result", "error"]),
    result: z
      .union([reviewWorkflowAssignmentSchema, reviewWorkflowSummarySchema])
      .nullable(),
    states,
  }),
  z.strictObject({
    kind: z.literal("end"),
    reason: z.enum(["shutdown", "audit-limit"]),
    nativeAccountingComplete: z.boolean(),
    states,
  }),
]);
const [headerBody, beginBody, finishBody, endBody] = legacyBodySchema.options;
const bodySchema = z.discriminatedUnion("kind", [
  headerBody,
  beginBody,
  finishBody.extend({
    nativeReceipt: reviewWorkflowNativeReceiptSchema.nullable(),
  }),
  endBody,
]);
const eventFields = {
  epochId: z.string().uuid(),
  sequence: count,
  createdAt: z.string().datetime(),
  previous: digest.nullable(),
  digest,
};
const eventSchema = z.discriminatedUnion("schemaVersion", [
  z.strictObject({
    ...eventFields,
    schemaVersion: z.literal(1),
    body: legacyBodySchema,
  }),
  z.strictObject({
    ...eventFields,
    schemaVersion: z.literal(2),
    body: bodySchema,
  }),
]);
type Body = z.infer<typeof bodySchema>;
const sha = (text: string | Buffer): string =>
  createHash("sha256").update(text).digest("hex");
function privateStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_BYTES
  )
    throw new Error("Audit requires a bounded private singly linked file");
}
export function captureReviewWorkflowCommand(input: unknown): {
  capture: Capture;
  value: unknown;
  operation: z.infer<typeof operation>;
} {
  let text: string;
  try {
    text = JSON.stringify(input);
    if (typeof text !== "string") throw new Error();
  } catch {
    return {
      capture: {
        kind: "unserializable",
        bytes: null,
        sha256: null,
        value: null,
        prefixBase64: null,
        untrustedData: true,
      },
      value: null,
      operation: "invalid",
    };
  }
  const size = Buffer.byteLength(text);
  const captured: Capture =
    size <= COMMAND_BYTES
      ? {
          kind: "complete",
          bytes: size,
          sha256: sha(text),
          value: JSON.parse(text),
          prefixBase64: null,
          untrustedData: true,
        }
      : {
          kind: "prefix",
          bytes: size,
          sha256: sha(text),
          value: null,
          prefixBase64: Buffer.from(text).subarray(0, 4096).toString("base64"),
          untrustedData: true,
        };
  const parsed = reviewWorkflowCommandSchema.safeParse(captured.value);
  return {
    capture: captured,
    value: captured.value,
    operation: parsed.success ? parsed.data.operation : "invalid",
  };
}
export class ReviewWorkflowAuditLimitError extends Error {}
function prepareAudit(
  root: string,
  options: ReviewWorkflowAuditOptions,
  engine: ReviewWorkflowOptions,
) {
  const limits = reviewWorkflowAuditOptionsSchema.parse(options);
  if (
    process.platform === "win32" ||
    !engine.allowReviewSource ||
    !path.isAbsolute(limits.file)
  )
    throw new Error(
      "Audit requires POSIX, startup source disclosure and an absolute operator path",
    );
  const parent = realpathSync(path.dirname(limits.file));
  const directory = lstatSync(path.dirname(limits.file));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o777) !== 0o700
  )
    throw new Error(
      "Audit parent must be an existing private operator directory",
    );
  const file = path.join(parent, path.basename(limits.file));
  const project = realpathSync(root);
  const relative = path.relative(project, file);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("Audit must be outside the project root");
  const header: Extract<Body, { kind: "header" }> = {
    kind: "header",
    engineVersion: VERSION,
    engineRuntimeDigest: observeReviewEngineDigest(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    rootDigest: sha(project),
    ...(limits.binding ? { binding: limits.binding } : {}),
    maxBytes: limits.maxBytes,
    maxEvents: limits.maxEvents,
    settings: {
      allowReviewSource: true,
      trusted: Boolean(engine.trusted),
      workflowLimits: engine.limits ?? null,
      nativeWallMs: engine.nativeWallMs ?? 30000,
      maxNativeOutputBytes: engine.maxNativeOutputBytes ?? 65536,
      nativeBudget: engine.nativeBudget ?? {
        maxCalls: 16,
        maxOutputBytes: engine.maxNativeOutputBytes ?? 65536,
      },
      probes: (engine.probes ?? []).map((p) => ({
        id: JSON.parse(p.contents).id,
        sha256: p.sha256,
      })),
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(header)) + 1024 + END_BYTES >
      limits.maxBytes ||
    limits.maxEvents < 2
  )
    throw new ReviewWorkflowAuditLimitError(
      "Audit cannot reserve its terminal record",
    );
  return { limits, file, parent, header };
}

/** Fresh, private, fsynced append-only epoch. Existing files are never reopened for writing. */
export class ReviewWorkflowAudit {
  readonly #file: string;
  readonly #fd: number;
  readonly #limits: z.infer<typeof reviewWorkflowAuditOptionsSchema>;
  readonly #epochId = randomUUID();
  readonly #pending = new Map<string, number>();
  #bytes = 0;
  #sequence = 0;
  #previous: string | null = null;
  #closed = false;
  #broken = false;
  /** Preflight only: disposable MCP discovery processes must not spend an audit path. */
  static preflight(
    root: string,
    options: ReviewWorkflowAuditOptions,
    engine: ReviewWorkflowOptions,
  ): void {
    const { file } = prepareAudit(root, options, engine);
    try {
      lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error("Audit file already exists");
  }
  constructor(
    root: string,
    options: ReviewWorkflowAuditOptions,
    engine: ReviewWorkflowOptions,
  ) {
    const prepared = prepareAudit(root, options, engine);
    this.#limits = prepared.limits;
    this.#file = prepared.file;
    const { parent, header } = prepared;
    const line = this.#line(header);
    if (
      line.buffer.length + END_BYTES > this.#limits.maxBytes ||
      this.#limits.maxEvents < 2
    )
      throw new ReviewWorkflowAuditLimitError(
        "Audit cannot reserve its terminal record",
      );
    this.#fd = openSync(
      this.#file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      privateStat(fstatSync(this.#fd));
      this.#append(line);
      const directoryFd = openSync(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      closeSync(this.#fd);
      this.#closed = true;
      throw error;
    }
  }
  #line(body: Body): { buffer: Buffer; digest: string } {
    bodySchema.parse(body);
    const base = {
      schemaVersion: 2,
      epochId: this.#epochId,
      sequence: this.#sequence,
      createdAt: new Date().toISOString(),
      previous: this.#previous,
      body,
    };
    const hash = sha(JSON.stringify(base));
    return {
      buffer: Buffer.from(JSON.stringify({ ...base, digest: hash }) + "\n"),
      digest: hash,
    };
  }
  #identity(): void {
    if (this.#closed || this.#broken)
      throw new Error("Audit writer is unavailable");
    const stat = fstatSync(this.#fd),
      linked = lstatSync(this.#file);
    privateStat(stat);
    privateStat(linked);
    if (
      stat.dev !== linked.dev ||
      stat.ino !== linked.ino ||
      stat.size !== this.#bytes
    )
      throw new Error("Audit ownership or size changed");
  }
  #append(line: { buffer: Buffer; digest: string }): void {
    try {
      this.#identity();
      if (
        line.buffer.length > RECORD_BYTES ||
        this.#bytes + line.buffer.length > this.#limits.maxBytes ||
        this.#sequence >= this.#limits.maxEvents
      )
        throw new Error("Audit reservation exceeded");
      let written = 0;
      while (written < line.buffer.length) {
        const n = writeSync(
          this.#fd,
          line.buffer,
          written,
          line.buffer.length - written,
          null,
        );
        if (!n) throw new Error("Audit write made no progress");
        written += n;
      }
      fsyncSync(this.#fd);
      this.#bytes += line.buffer.length;
      this.#sequence++;
      this.#previous = line.digest;
      this.#identity();
    } catch (error) {
      this.#broken = true;
      throw error;
    }
  }
  begin(
    capture: Capture,
    op: z.infer<typeof operation>,
    snapshots: z.infer<typeof states>,
  ): string {
    this.#identity();
    const commandId = randomUUID();
    const line = this.#line({
      kind: "begin",
      commandId,
      operation: op,
      capture,
      states: snapshots,
    });
    const reserved = [...this.#pending.values()].reduce((a, b) => a + b, 0);
    if (
      this.#pending.size >= 16 ||
      line.buffer.length > RECORD_BYTES ||
      this.#bytes + reserved + line.buffer.length + RECORD_BYTES + END_BYTES >
        this.#limits.maxBytes ||
      this.#sequence + this.#pending.size + 3 > this.#limits.maxEvents
    )
      throw new ReviewWorkflowAuditLimitError(
        "Audit command capacity exhausted",
      );
    this.#append(line);
    this.#pending.set(commandId, RECORD_BYTES);
    return commandId;
  }
  finish(
    commandId: string,
    result:
      | z.infer<typeof reviewWorkflowAssignmentSchema>
      | z.infer<typeof reviewWorkflowSummarySchema>
      | null,
    snapshots: z.infer<typeof states>,
    nativeReceipt: ReviewWorkflowNativeReceipt | null = null,
  ): void {
    if (!this.#pending.has(commandId))
      throw new Error("Audit command is not pending");
    const line = this.#line({
      kind: "finish",
      commandId,
      outcome: result === null ? "error" : "result",
      nativeReceipt,
      result,
      states: snapshots,
    });
    if (line.buffer.length > this.#pending.get(commandId)!) {
      this.#broken = true;
      throw new Error("Audit result exceeds reservation");
    }
    this.#append(line);
    this.#pending.delete(commandId);
  }
  close(
    snapshots: z.infer<typeof states>,
    reason: "shutdown" | "audit-limit" = "shutdown",
  ): void {
    if (this.#closed) return;
    try {
      if (!this.#broken) {
        if (this.#pending.size)
          throw new Error("Audit cannot finalize pending commands");
        const line = this.#line({
          kind: "end",
          reason,
          nativeAccountingComplete: snapshots.every(
            (s) => s.native.accountingComplete,
          ),
          states: snapshots,
        });
        if (line.buffer.length > END_BYTES)
          throw new Error("Audit terminal record exceeds reservation");
        this.#append(line);
      }
    } finally {
      this.#closed = true;
      closeSync(this.#fd);
    }
  }
}
function checkedCapture(capture: Capture): void {
  if (capture.kind === "complete") {
    const text = JSON.stringify(capture.value);
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) !== capture.bytes ||
      sha(text) !== capture.sha256 ||
      capture.prefixBase64 !== null ||
      capture.bytes! > COMMAND_BYTES
    )
      throw new Error("Audit command capture disagrees");
  } else if (capture.kind === "unserializable") {
    if (
      capture.bytes !== null ||
      capture.sha256 !== null ||
      capture.value !== null ||
      capture.prefixBase64 !== null
    )
      throw new Error("Invalid unavailable command capture");
  } else if (
    capture.value !== null ||
    capture.bytes === null ||
    capture.bytes <= COMMAND_BYTES ||
    !capture.sha256 ||
    !capture.prefixBase64 ||
    Buffer.from(capture.prefixBase64, "base64").length !== 4096 ||
    Buffer.from(capture.prefixBase64, "base64").toString("base64") !==
      capture.prefixBase64
  )
    throw new Error("Invalid bounded command prefix");
}
function checkSnapshots(
  current: z.infer<typeof states>,
  previous: z.infer<typeof states>,
): void {
  const workflows = new Map(current.map((state) => [state.workflowId, state])),
    assignments = new Set<string>();
  if (workflows.size !== current.length)
    throw new Error("Duplicate audit workflow state");
  for (const state of current) {
    if (
      state.assignments.length > state.limits.maxAssignments ||
      state.retainedBytes > state.limits.maxRetainedBytes ||
      current.length > state.limits.maxWorkflows ||
      state.issuedPacketBytes !==
        state.assignments.reduce(
          (sum, attempt) => sum + attempt.packetBytes,
          0,
        ) ||
      state.responseBytes !==
        state.assignments.reduce(
          (sum, attempt) => sum + attempt.responseBytes,
          0,
        ) ||
      state.native.accountingComplete !==
        (state.native.calls !== null && state.native.outputBytes !== null)
    )
      throw new Error("Audit workflow accounting disagrees");
    for (const attempt of state.assignments) {
      if (
        assignments.has(attempt.assignmentId) ||
        attempt.packetBytes > state.limits.maxPacketBytes
      )
        throw new Error("Audit assignment accounting disagrees");
      assignments.add(attempt.assignmentId);
    }
  }
  for (const old of previous) {
    const state = workflows.get(old.workflowId);
    if (
      !state ||
      state.contextDigest !== old.contextDigest ||
      JSON.stringify(state.limits) !== JSON.stringify(old.limits) ||
      state.assignments.length < old.assignments.length ||
      state.issuedPacketBytes < old.issuedPacketBytes ||
      state.responseBytes < old.responseBytes
    )
      throw new Error("Audit workflow history disappeared or changed");
    if (
      old.native.accountingComplete &&
      old.native.status !== "not-started" &&
      (!state.native.accountingComplete ||
        state.native.calls! < old.native.calls! ||
        state.native.outputBytes! < old.native.outputBytes!)
    )
      throw new Error("Audit native accounting changed");
    for (const [i, before] of old.assignments.entries()) {
      const after = state.assignments[i]!;
      if (
        after.assignmentId !== before.assignmentId ||
        after.assignmentDigest !== before.assignmentDigest ||
        after.stage !== before.stage ||
        after.packetBytes !== before.packetBytes ||
        after.responseBytes < before.responseBytes ||
        (before.status !== "awaiting-host" &&
          JSON.stringify(before) !== JSON.stringify(after)) ||
        (before.responseDigest !== null &&
          after.responseDigest !== before.responseDigest)
      )
        throw new Error("Audit assignment history changed");
    }
  }
}
function checkNativeReceipt(
  receipt: ReviewWorkflowNativeReceipt,
  state: z.infer<typeof reviewWorkflowSummarySchema>,
  startup: z.infer<typeof reviewWorkflowAuditSettingsSchema>,
): void {
  const recipe = parseReviewProbe(receipt.recipe);
  const run = parseReviewProbeRun(receipt.run);
  const registered = startup.probes.find((p) => p.id === receipt.probeId);
  if (
    !startup.trusted ||
    !registered ||
    registered.sha256 !== receipt.recipe.sha256 ||
    recipe.id !== receipt.probeId ||
    recipe.family !== receipt.candidate.family ||
    run.schemaVersion === 1 ||
    run.recipeDigest !== receipt.recipe.sha256 ||
    run.contextDigest !== state.contextDigest ||
    run.candidateDigest !== sha(JSON.stringify(receipt.candidate)) ||
    run.minimumTriggerScale !== recipe.minimumTriggerScale ||
    JSON.stringify(run.guard) !== JSON.stringify(recipe.guard) ||
    !receipt.candidate.citations.some(
      (c) =>
        c.file === recipe.file &&
        c.revision === "current" &&
        c.sourceDigest === run.sourceDigest,
    ) ||
    run.nativeBudget.calls !== state.native.calls ||
    run.nativeBudget.outputBytes !== state.native.outputBytes ||
    !state.native.accountingComplete ||
    run.trials.length !== recipe.cases.length ||
    run.nativeBudget.limits.maxCalls !== startup.nativeBudget.maxCalls ||
    run.nativeBudget.limits.maxOutputBytes !==
      startup.nativeBudget.maxOutputBytes ||
    run.nativeBudget.limits.maxCallOutputBytes !==
      startup.maxNativeOutputBytes ||
    run.nativeBudget.limits.wallMs > startup.nativeWallMs ||
    run.trials.some((trial, i) => {
      const expected = recipe.cases[i]!;
      return (
        trial.id !== expected.id ||
        trial.role !== expected.role ||
        trial.expected !== expected.expected ||
        trial.inputScale !== reviewProbeInputScale(expected.args)
      );
    })
  )
    throw new Error(
      "Audit native receipt evidence or startup binding disagrees",
    );
}
/** Inspect a frozen private journal; no resume, source output, execution or host inference. */
/** Operator-only snapshot. It contains untrusted source and response text. */
export function readReviewWorkflowAuditBytes(
  filename: string,
  maxBytes = MAX_BYTES,
): Buffer {
  const fd = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let content: Buffer;
  try {
    const before = fstatSync(fd);
    privateStat(before);
    if (before.size > maxBytes)
      throw new Error("Audit snapshot exceeds reader bounds");
    content = Buffer.alloc(before.size);
    let read = 0;
    while (read < content.length) {
      const n = readSync(fd, content, read, content.length - read, read);
      if (!n) throw new Error("Audit read ended early");
      read += n;
    }
    const after = fstatSync(fd),
      linked = lstatSync(filename);
    privateStat(after);
    privateStat(linked);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== linked.dev ||
      after.ino !== linked.ino
    )
      throw new Error("Audit changed while inspecting");
  } finally {
    closeSync(fd);
  }
  return content;
}
/** Validates a captured snapshot without reopening the path. */
export function parseReviewWorkflowAuditArtifact(content: Buffer) {
  const events: z.infer<typeof eventSchema>[] = [];
  const last = content.lastIndexOf(10),
    prefix = content.subarray(0, last + 1);
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(prefix)
    .split("\n");
  lines.pop();
  if (!lines.length || lines.length > 4096)
    throw new Error("Invalid audit event inventory");
  let previous: string | null = null,
    epochId: string | undefined,
    journalVersion: 1 | 2 | undefined,
    header: Extract<Body, { kind: "header" }> | undefined,
    end: Extract<Body, { kind: "end" }> | undefined;
  const pending = new Map<string, Extract<Body, { kind: "begin" }>>(),
    seen = new Set<string>(),
    nativeReceipts = new Map<string, ReviewWorkflowNativeReceipt>(),
    candidates = new Map<string, Map<string, string>>();
  let snapshots: z.infer<typeof states> = [],
    finished = 0,
    rejected = 0,
    allBodies = true;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) + 1 > RECORD_BYTES)
      throw new Error("Audit record exceeds bounds");
    const raw: unknown = JSON.parse(line);
    const event = eventSchema.parse(raw);
    events.push(event);
    // Hash the recorded key order, before schema parsing normalizes it.
    const { digest: hash, ...base } = raw as Record<string, unknown>;
    if (
      hash !== sha(JSON.stringify(base)) ||
      event.sequence !== index ||
      event.previous !== previous ||
      (epochId && event.epochId !== epochId) ||
      (journalVersion && event.schemaVersion !== journalVersion) ||
      end
    )
      throw new Error("Audit chain or ordering disagrees");
    epochId = event.epochId;
    journalVersion = event.schemaVersion;
    previous = hash;
    if (index === 0) {
      if (event.body.kind !== "header") throw new Error("Missing audit header");
      header = event.body;
      if (
        header.maxBytes > MAX_BYTES ||
        header.maxEvents > 4096 ||
        content.length > header.maxBytes ||
        lines.length > header.maxEvents
      )
        throw new Error("Audit header bounds disagree");
      continue;
    }
    if (event.body.kind === "header") throw new Error("Repeated audit header");
    const body = event.body;
    checkSnapshots(body.states, snapshots);
    snapshots = body.states;
    for (const [id, receipt] of nativeReceipts) {
      const native = snapshots.find((s) => s.workflowId === id)!.native;
      if (
        receipt.run.schemaVersion === 1 ||
        native.calls !== receipt.run.nativeBudget.calls ||
        native.outputBytes !== receipt.run.nativeBudget.outputBytes ||
        !native.accountingComplete
      )
        throw new Error("Audit retained native accounting changed");
    }
    if (body.kind === "begin") {
      checkedCapture(body.capture);
      const parsed = reviewWorkflowCommandSchema.safeParse(body.capture.value);
      if (
        body.operation !==
          (parsed.success ? parsed.data.operation : "invalid") ||
        seen.has(body.commandId) ||
        pending.size >= 16
      )
        throw new Error("Audit command identity disagrees");
      seen.add(body.commandId);
      pending.set(body.commandId, body);
      allBodies &&= body.capture.kind === "complete";
    } else if (body.kind === "finish") {
      if (
        !pending.has(body.commandId) ||
        (body.outcome === "result") !== (body.result !== null)
      )
        throw new Error("Unmatched audit result");
      const began = pending.get(body.commandId)!;
      const command = reviewWorkflowCommandSchema.safeParse(
        began.capture.value,
      );
      if (command.success && command.data.operation === "submit") {
        const response = reviewWorkflowResponseSchema.safeParse(
          command.data.response,
        );
        const workflowId = command.data.workflowId;
        const state = snapshots.find((s) => s.workflowId === workflowId);
        const attempt = state?.assignments.at(-1);
        if (
          body.outcome === "result" &&
          response.success &&
          response.data.output &&
          attempt?.stage === "reviewer" &&
          attempt.status === "accepted" &&
          attempt.assignmentId === response.data.assignmentId &&
          attempt.assignmentDigest === response.data.assignmentDigest &&
          attempt.responseDigest ===
            sha(JSON.stringify(command.data.response)) &&
          began.states
            .find((s) => s.workflowId === workflowId)
            ?.assignments.at(-1)?.status === "awaiting-host"
        ) {
          if (
            state!.candidateHandles.length !==
            response.data.output.candidates.length
          )
            throw new Error("Audit candidate handles disagree");
          candidates.set(
            state!.workflowId,
            new Map(
              state!.candidateHandles.map((handle, i) => [
                handle,
                sha(JSON.stringify(response.data.output!.candidates[i])),
              ]),
            ),
          );
        }
      }
      if ("nativeReceipt" in body) {
        const receipt = body.nativeReceipt;
        const workflowId =
          command.success && command.data.operation === "probe"
            ? command.data.workflowId
            : undefined;
        const state = snapshots.find((s) => s.workflowId === workflowId);
        if (receipt) {
          if (
            !command.success ||
            command.data.operation !== "probe" ||
            !state ||
            receipt.workflowId !== command.data.workflowId ||
            receipt.probeId !== command.data.probeId ||
            receipt.targetHandle !== state.selectedTarget ||
            nativeReceipts.has(receipt.workflowId) ||
            candidates.get(receipt.workflowId)?.get(receipt.targetHandle) !==
              sha(JSON.stringify(receipt.candidate))
          )
            throw new Error(
              "Audit native command or candidate binding disagrees",
            );
          if (
            receipt.run.engineVersion !== header!.engineVersion ||
            receipt.run.runtime.version !==
              header!.runtime.node.replace(/^v/, "")
          )
            throw new Error("Audit native runtime identity disagrees");
          checkNativeReceipt(receipt, state, header!.settings);
          nativeReceipts.set(receipt.workflowId, receipt);
        } else if (
          state?.native.accountingComplete &&
          state.native.status !== "not-started" &&
          !nativeReceipts.has(state.workflowId)
        )
          throw new Error("Audit reached native receipt is missing");
      }
      pending.delete(body.commandId);
      finished++;
      if (body.outcome === "error") rejected++;
      if (body.result?.format === "review-workflow-assignment") {
        const { assignmentDigest, ...assignment } = body.result;
        const issued = snapshots
          .flatMap((state) => state.assignments)
          .filter(
            (attempt) => attempt.assignmentId === assignment.assignmentId,
          );
        if (
          assignmentDigest !== sha(JSON.stringify(assignment)) ||
          issued.length !== 1 ||
          issued[0]!.assignmentDigest !== assignmentDigest ||
          issued[0]!.stage !== assignment.stage ||
          issued[0]!.packetBytes !==
            Buffer.byteLength(JSON.stringify(body.result))
        )
          throw new Error("Audit assignment binding disagrees");
      }
    } else {
      if (
        pending.size ||
        body.nativeAccountingComplete !==
          snapshots.every((s) => s.native.accountingComplete)
      )
        throw new Error("Audit terminal accounting disagrees");
      end = body;
    }
  }
  const trailing = content.length - prefix.length;
  if (end && trailing) throw new Error("Bytes follow audit finalization");
  const summary = reviewWorkflowAuditSummarySchema.parse({
    schemaVersion: 2,
    journalVersion: journalVersion!,
    format: "review-workflow-audit-summary",
    epochId: epochId!,
    engineVersion: header!.engineVersion,
    journalStatus: end ? "sealed" : "interrupted",
    prefixIntegrityVerified: true,
    externallyAnchored: false,
    claimsVerified: false,
    hostIsolationVerified: false,
    sourceIncluded: false,
    events: lines.length,
    bytes: content.length,
    trailingBytes: trailing,
    digest: previous!,
    allCommandBodiesRetained: allBodies,
    nativeReceipts: {
      retained: nativeReceipts.size,
      complete:
        !pending.size &&
        snapshots.every(
          (s) =>
            s.native.status === "not-started" ||
            (s.native.accountingComplete && nativeReceipts.has(s.workflowId)),
        ),
      rawOutputIncluded: false,
    },
    nativeAccountingComplete:
      !pending.size && snapshots.every((s) => s.native.accountingComplete),
    commands: { started: seen.size, finished, rejected, pending: pending.size },
    workflows: snapshots,
  });
  return { summary, header: header!, events };
}
export function inspectReviewWorkflowAudit(
  filename: string,
): ReviewWorkflowAuditSummary {
  return parseReviewWorkflowAuditArtifact(
    readReviewWorkflowAuditBytes(filename),
  ).summary;
}
