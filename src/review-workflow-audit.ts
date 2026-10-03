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
import { VERSION } from "./types.js";
import {
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
  reviewWorkflowCommandSchema,
} from "./review-workflow-schema.js";
import type { ReviewWorkflowOptions } from "./review-workflow.js";
import {
  reviewWorkflowAuditOptionsSchema,
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
const settings = z.strictObject({
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
const bodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("header"),
    engineVersion: z.string().min(1).max(128),
    runtime: z.strictObject({
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
    rootDigest: digest,
    maxBytes: count,
    maxEvents: count,
    settings,
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
const eventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  epochId: z.string().uuid(),
  sequence: count,
  createdAt: z.string().datetime(),
  previous: digest.nullable(),
  body: bodySchema,
  digest,
});
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
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    rootDigest: sha(project),
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
        maxOutputBytes: 65536,
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
      schemaVersion: 1,
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
  ): void {
    if (!this.#pending.has(commandId))
      throw new Error("Audit command is not pending");
    const line = this.#line({
      kind: "finish",
      commandId,
      outcome: result === null ? "error" : "result",
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
/** Inspect a frozen private journal; no resume, source output, execution or host inference. */
export function inspectReviewWorkflowAudit(
  filename: string,
): ReviewWorkflowAuditSummary {
  const fd = openSync(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let content: Buffer;
  try {
    const before = fstatSync(fd);
    privateStat(before);
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
    header: Extract<Body, { kind: "header" }> | undefined,
    end: Extract<Body, { kind: "end" }> | undefined;
  const pending = new Map<string, z.infer<typeof operation>>(),
    seen = new Set<string>();
  let snapshots: z.infer<typeof states> = [],
    finished = 0,
    rejected = 0,
    allBodies = true;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) + 1 > RECORD_BYTES)
      throw new Error("Audit record exceeds bounds");
    const event = eventSchema.parse(JSON.parse(line));
    const { digest: hash, ...base } = event;
    if (
      hash !== sha(JSON.stringify(base)) ||
      event.sequence !== index ||
      event.previous !== previous ||
      (epochId && event.epochId !== epochId) ||
      end
    )
      throw new Error("Audit chain or ordering disagrees");
    epochId = event.epochId;
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
      pending.set(body.commandId, body.operation);
      allBodies &&= body.capture.kind === "complete";
    } else if (body.kind === "finish") {
      if (
        !pending.has(body.commandId) ||
        (body.outcome === "result") !== (body.result !== null)
      )
        throw new Error("Unmatched audit result");
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
  return reviewWorkflowAuditSummarySchema.parse({
    schemaVersion: 1,
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
    nativeAccountingComplete:
      !pending.size && snapshots.every((s) => s.native.accountingComplete),
    commands: { started: seen.size, finished, rejected, pending: pending.size },
    workflows: snapshots,
  });
}
