import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { evaluate } from "../dist/src/evidence.js";
import { analyzeSessionEvents } from "./agent-evaluation-session.mjs";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !/[\\\0]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
const evidenceId = z.string().regex(/^evidence-[1-9]\d*-[a-f0-9]{12}$/);
const unique = (values) => new Set(values).size === values.length;
export const probeEvidenceIds = z
  .array(evidenceId)
  .min(1)
  .max(16)
  .refine(unique);
export const nativeEvidenceSchema = z.strictObject({
  parser: z.enum(["unittest", "vitest-json"]),
  scope: z.array(relative).min(1).max(1000).refine(unique),
});
export const executionProfileSchema = z.strictObject({
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  runtimeSha256: sha,
  dependenciesSha256: sha.nullable(),
  native: z.strictObject({
    executable: z.enum(["node", "python3"]),
    args: z.array(z.string().max(2048)).max(64),
  }),
  languages: z
    .array(z.enum(["javascript", "python"]))
    .min(1)
    .max(2)
    .refine(unique),
  timeoutMs: z.number().int().min(100).max(120000),
  maxOutputBytes: z.number().int().min(1024).max(1048576),
});
const budgetSchema = z.strictObject({
  wallSeconds: z.number().int().min(1).max(3600),
  maxToolCalls: z.number().int().min(1).max(500),
  maxInputTokens: integer.positive().nullable(),
  maxOutputTokens: integer.positive(),
});
export const executionProtocolSchema = z.strictObject({
  kind: z.literal("gateway-v1"),
  judgeBudget: budgetSchema,
  judgeProfile: executionProfileSchema,
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => JSON.stringify(value) + "\n";
const recordId = (record) =>
  `evidence-${record.sequence}-${record.sha256.slice(0, 12)}`;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const executionTools = new Set([
  "evaluation_native",
  "evaluation_probe",
  "checktrail_plan",
  "checktrail_validate",
]);
const tools = new Set([
  "evaluation_files",
  "evaluation_read",
  "evaluation_citation",
  ...executionTools,
]);
const toolArguments = {
  evaluation_files: z.strictObject({}),
  evaluation_read: z.strictObject({
    file: relative,
    line: integer.positive().default(1),
    count: integer.min(1).max(200).default(100),
  }),
  evaluation_citation: z.strictObject({
    file: relative,
    line: integer.positive(),
    endLine: integer.positive(),
    quote: z.string().max(16000),
  }),
  evaluation_native: z.strictObject({}),
  evaluation_probe: z.strictObject({
    language: z.enum(["javascript", "python"]),
    code: z.string().min(1).max(16000),
    sourceEvidenceIds: probeEvidenceIds.optional(),
  }),
  checktrail_plan: z.strictObject({}),
  checktrail_validate: z.strictObject({}),
};

async function boundedFile(directory, name, limit) {
  const handle = await fs.open(
    path.join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error("Not a bounded regular file");
    const chunks = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > limit) throw new Error("Evidence file exceeds limit");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const raw = Buffer.concat(chunks);
    const text = raw.toString("utf8");
    if (!Buffer.from(text).equals(raw))
      throw new Error("Evidence is not UTF-8");
    return text;
  } finally {
    await handle.close();
  }
}

export async function readProtocolEvidence(directory) {
  const bundle = {
    auditText: null,
    eventsText: null,
    metering: null,
    problems: [],
  };
  try {
    if (
      (await fs.realpath(directory)) !== path.resolve(directory) ||
      !(await fs.lstat(directory)).isDirectory()
    )
      throw new Error("Evidence directory must be canonical");
  } catch {
    bundle.problems.push("evidence-directory-unavailable");
    return bundle;
  }
  for (const [name, key, limit] of [
    ["gateway-audit.jsonl", "auditText", 128 * 1024 * 1024],
    ["events.jsonl", "eventsText", 32 * 1024 * 1024],
    ["metering.json", "metering", 32 * 1024 * 1024],
  ]) {
    try {
      const text = await boundedFile(directory, name, limit);
      bundle[key] = key === "metering" ? JSON.parse(text) : text;
    } catch {
      bundle.problems.push(`${name}-unavailable-or-invalid`);
    }
  }
  return bundle;
}

function boundedExecution(value, exitCodes) {
  return (
    object(value) &&
    exitCodes.includes(value.exitCode) &&
    value.timedOut === false &&
    value.truncated === false &&
    value.cancelled === false &&
    (value.signal === null || value.signal === undefined) &&
    !value.errorCode &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string"
  );
}

function positiveTests(tests) {
  return (
    object(tests) &&
    ["total", "passed", "failed", "skipped"].every((key) =>
      count(tests[key]),
    ) &&
    tests.total === tests.passed + tests.failed + tests.skipped &&
    tests.passed + tests.failed > 0
  );
}

function nativeComplete(value, expected) {
  if (!expected.nativeEvidence || !boundedExecution(value, [0, 1]))
    return false;
  const declaration = nativeEvidenceSchema.parse(expected.nativeEvidence);
  const command = { ...expected.profile.native, cwd: "." };
  const check = {
    id: "evaluation.native",
    adapter: declaration.parser === "unittest" ? "python" : "javascript",
    project: ".",
    scope: declaration.scope,
    kind: "test",
    parser: declaration.parser,
    commands: [command],
    reason: "Frozen native comparator",
  };
  const result = evaluate(check, [{ ...value, command }], "/source");
  return (
    ["passed", "failed"].includes(result.status) &&
    positiveTests(result.tests) &&
    (value.exitCode === 0
      ? result.tests.failed === 0 && result.status === "passed"
      : result.tests.failed > 0 && result.status === "failed")
  );
}

function validationComplete(value, expected) {
  if (!boundedExecution(value, [0])) return false;
  const trace = value.trace;
  const result = trace?.result;
  const report = result?.structuredContent;
  if (
    expected.engineVersion !== undefined &&
    trace?.server?.version !== expected.engineVersion
  )
    return false;
  if (
    trace?.action !== "validation_run" ||
    result?.isError === true ||
    trace?.retainedReport?.isError === true ||
    !object(report) ||
    !isDeepStrictEqual(report, trace.retainedReport?.structuredContent)
  )
    return false;
  if (
    !["passed", "failed"].includes(report.outcome) ||
    report.sourceChanged !== false ||
    report.sourceError !== false ||
    typeof report.sourceFingerprint !== "string" ||
    report.finalSourceFingerprint !== report.sourceFingerprint ||
    !Array.isArray(report.checks) ||
    !report.checks.length
  )
    return false;
  return (
    report.checks.every(
      (check) =>
        object(check) &&
        ["passed", "failed"].includes(check.status) &&
        Array.isArray(check.processes) &&
        check.processes.length > 0 &&
        check.processes.every((process) => boundedExecution(process, [0, 1])) &&
        (check.tests === undefined ||
          (positiveTests(check.tests) &&
            (check.status === "passed"
              ? check.tests.failed === 0
              : check.tests.failed > 0))),
    ) && report.checks.some((check) => positiveTests(check.tests))
  );
}

function executionAttempt(call, profile, treatment) {
  if (
    !executionTools.has(call.tool) ||
    (!treatment && call.tool.startsWith("checktrail_"))
  )
    return false;
  const args = call.arguments;
  if (!object(args)) return false;
  if (call.tool !== "evaluation_probe") return Object.keys(args).length === 0;
  return (
    Object.keys(args).every((key) =>
      ["language", "code", "sourceEvidenceIds"].includes(key),
    ) &&
    profile.languages.includes(args.language) &&
    typeof args.code === "string" &&
    args.code.length > 0 &&
    args.code.length <= 16000 &&
    (args.sourceEvidenceIds === undefined ||
      probeEvidenceIds.safeParse(args.sourceEvidenceIds).success)
  );
}

export function verifyProtocolEvidence(bundle, expected) {
  const problems = [
    ...(Array.isArray(bundle?.problems) ? bundle.problems : []),
  ];
  const result = {
    complete: false,
    problems,
    probes: [],
    probeSources: {},
    reads: [],
    native: [],
    validations: [],
    submission: null,
    toolCalls: 0,
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUsd: null,
      provenance: "orchestrator-measured",
    },
    auditSha256:
      typeof bundle?.auditText === "string" ? hash(bundle.auditText) : null,
    eventsSha256:
      typeof bundle?.eventsText === "string" ? hash(bundle.eventsText) : null,
  };
  const fail = (message) => {
    if (!problems.includes(message)) problems.push(message);
  };
  try {
    expected = {
      ...expected,
      budget: Object.fromEntries(
        [
          "wallSeconds",
          "maxToolCalls",
          "maxInputTokens",
          "maxOutputTokens",
        ].map((key) => [key, expected.budget[key]]),
      ),
    };
    executionProfileSchema.parse(expected.profile);
    budgetSchema.parse(expected.budget);
    const meter = bundle?.metering;
    let analysis;
    if (!object(meter)) fail("metering-missing");
    else {
      if (!isDeepStrictEqual(meter.binding, expected.binding))
        fail("metering-binding-mismatch");
      if (!["claude", "codex"].includes(meter.client))
        fail("metering-client-invalid");
      else if (typeof bundle.eventsText !== "string") fail("events-missing");
      else {
        analysis = analyzeSessionEvents(Buffer.from(bundle.eventsText), {
          client: meter.client,
          budget: expected.budget,
        });
        for (const violation of analysis.violations)
          fail(`session-${violation}`);
        if (!analysis.terminalObserved || !analysis.terminalSuccess)
          fail("session-terminal-incomplete");
        for (const field of [
          "parserVersion",
          "terminalObserved",
          "terminalSuccess",
          "inputTokens",
          "outputTokens",
          "toolCalls",
          "eventsSha256",
          "eventsBytes",
          "tools",
          "submission",
        ])
          if (!isDeepStrictEqual(meter[field], analysis[field]))
            fail(`metering-${field}-mismatch`);
        result.toolCalls = analysis.toolCalls;
        result.submission = analysis.submission ?? null;
        result.usage.inputTokens = analysis.inputTokens;
        result.usage.outputTokens = analysis.outputTokens;
        if (
          !count(analysis.outputTokens) ||
          (expected.budget.maxInputTokens !== null &&
            !count(analysis.inputTokens))
        )
          fail("required-token-usage-unknown");
        if (analysis.toolCalls > expected.budget.maxToolCalls)
          fail("tool-call-budget-exceeded");
        if (
          analysis.outputTokens > expected.budget.maxOutputTokens ||
          (expected.budget.maxInputTokens !== null &&
            analysis.inputTokens > expected.budget.maxInputTokens)
        )
          fail("token-budget-exceeded");
      }
      if (
        typeof meter.elapsedMs !== "number" ||
        !Number.isFinite(meter.elapsedMs) ||
        meter.elapsedMs < 0
      )
        fail("elapsed-time-unknown");
      else {
        result.usage.elapsedMs = meter.elapsedMs;
        if (meter.elapsedMs > expected.budget.wallSeconds * 1000)
          fail("wall-time-budget-exceeded");
      }
      if (
        meter.exitCode !== 0 ||
        meter.exitSignal !== null ||
        meter.stoppedReason !== null
      )
        fail("session-process-incomplete");
    }
    if (typeof bundle.auditText !== "string" || !bundle.auditText.length) {
      fail("gateway-audit-missing");
      return result;
    }
    if (Buffer.byteLength(bundle.auditText) > 128 * 1024 * 1024) {
      fail("gateway-audit-byte-limit");
      return result;
    }
    if (!bundle.auditText.endsWith("\n")) fail("gateway-audit-truncated");
    const lines = bundle.auditText.trimEnd().split("\n");
    if (lines.length > 10000) {
      fail("gateway-audit-record-limit");
      return result;
    }
    const records = lines.map((line) => JSON.parse(line));
    let previous = null;
    for (const [index, record] of records.entries()) {
      if (!object(record)) throw new Error("Invalid audit record");
      const { sha256, ...content } = record;
      if (
        record.sequence !== index + 1 ||
        record.previous !== previous ||
        sha256 !== hash(encode(content))
      )
        fail("gateway-chain-invalid");
      previous = sha256;
    }
    const start = records[0],
      end = records.at(-1);
    if (
      start.type !== "start" ||
      records.filter((record) => record.type === "start").length !== 1 ||
      start.auditVersion !== 2 ||
      start.integrityScope !== "mounted-trees-per-execution"
    )
      fail("gateway-start-invalid");
    if (!isDeepStrictEqual(start.binding, expected.binding))
      fail("gateway-binding-mismatch");
    if (!isDeepStrictEqual(start.profile, expected.profile))
      fail("gateway-profile-mismatch");
    if (
      start.gatewaySha256 !== expected.gatewaySha256 ||
      start.workerSha256 !== expected.workerSha256
    )
      fail("gateway-implementation-mismatch");
    if (
      start.image !== expected.profile.image ||
      start.runtimeSha256 !== expected.profile.runtimeSha256 ||
      start.dependenciesSha256 !== expected.profile.dependenciesSha256 ||
      start.treatment !== expected.treatment
    )
      fail("gateway-mount-or-arm-mismatch");
    if (
      !object(start.budget) ||
      !count(start.budget.maxCalls) ||
      start.budget.maxCalls < 1 ||
      start.budget.maxCalls > expected.budget.maxToolCalls ||
      start.budget.timeoutMs !== expected.profile.timeoutMs ||
      start.budget.maxOutputBytes !== expected.profile.maxOutputBytes
    )
      fail("gateway-budget-mismatch");
    const sources = new Map();
    if (!Array.isArray(start.files)) fail("gateway-source-invalid");
    else
      for (const file of start.files) {
        if (
          !object(file) ||
          !relative.safeParse(file.file).success ||
          !sha.safeParse(file.sha256).success ||
          !count(file.bytes) ||
          sources.has(file.file)
        )
          fail("gateway-source-invalid");
        else sources.set(file.file, file.sha256);
      }
    if (expected.exactFiles && sources.size !== expected.files.length)
      fail("gateway-source-mismatch");
    for (const file of expected.files)
      if (sources.get(file.file) !== file.sha256)
        fail("gateway-source-mismatch");
    if (
      end.type !== "end" ||
      records.filter((record) => record.type === "end").length !== 1 ||
      end.cleanupCompleted !== true ||
      end.sourceSnapshotRemoved !== true ||
      end.integrityScope !== "completed-execution-calls"
    )
      fail("gateway-cleanup-incomplete");
    const calls = [];
    const reads = new Map();
    let pending = null,
      errorCount = 0,
      attempts = 0,
      verified = 0,
      integrityFailures = 0;
    for (const record of records.slice(1, -1)) {
      if (record.type === "call") {
        if (pending) fail("gateway-call-result-order");
        pending = record;
        errorCount = 0;
        calls.push(record);
        if (
          !tools.has(record.tool) ||
          (!expected.treatment && record.tool.startsWith("checktrail_"))
        )
          fail("gateway-unexpected-tool");
      } else if (record.type === "error") {
        if (
          !pending ||
          record.attempt !== recordId(pending) ||
          typeof record.message !== "string" ||
          ++errorCount !== 1
        )
          fail("gateway-error-link-invalid");
      } else if (record.type === "result") {
        if (
          !pending ||
          record.attempt !== recordId(pending) ||
          record.tool !== pending.tool ||
          !object(record.result)
        ) {
          fail("gateway-result-link-invalid");
          pending = null;
          continue;
        }
        const call = pending;
        pending = null;
        const delivered = record.result,
          value = delivered.value,
          id = recordId(record);
        if (
          typeof delivered.ok !== "boolean" ||
          (delivered.ok ? errorCount !== 0 : errorCount !== 1)
        )
          fail("gateway-result-error-mismatch");
        if (
          delivered.ok &&
          !toolArguments[call.tool]?.safeParse(call.arguments).success
        )
          fail("gateway-successful-invalid-arguments");
        if (
          delivered.ok &&
          call.tool === "evaluation_probe" &&
          ((call.arguments.sourceEvidenceIds ?? []).some(
            (id) => !reads.has(id),
          ) ||
            !expected.profile.languages.includes(call.arguments.language))
        )
          fail("gateway-successful-invalid-probe");
        const executed =
          executionAttempt(call, expected.profile, expected.treatment) &&
          (call.tool !== "evaluation_probe" ||
            (call.arguments.sourceEvidenceIds ?? []).every((id) =>
              reads.has(id),
            )) &&
          calls.length <= start.budget.maxCalls;
        const integrity = delivered.ok ? value?.integrity : delivered.integrity;
        if (executed) {
          attempts++;
          if (integrity) {
            const expectedIdentity = {
              runtimeSha256: call.tool.startsWith("checktrail_")
                ? expected.profile.runtimeSha256
                : null,
              dependenciesSha256: expected.profile.dependenciesSha256,
            };
            if (
              integrity.scope !== "mounted-trees-per-execution" ||
              !isDeepStrictEqual(integrity.expected, expectedIdentity)
            )
              fail("gateway-execution-identity-invalid");
            if (
              integrity.verified === true &&
              isDeepStrictEqual(integrity.before, expectedIdentity) &&
              isDeepStrictEqual(integrity.after, expectedIdentity)
            )
              verified++;
            else if (
              integrity.reason !==
              "cancelled-before-post-execution-verification"
            ) {
              integrityFailures++;
              fail("gateway-execution-integrity-failed");
            }
          }
          if (!delivered.ok || integrity?.verified !== true)
            fail("gateway-execution-incomplete");
        }
        if (!delivered.ok) continue;
        if (call.tool === "evaluation_read") {
          const { file, line, count: requestedCount = 100 } = call.arguments;
          if (
            !object(value) ||
            value.file !== file ||
            value.line !== (line ?? 1) ||
            !count(value.endLine) ||
            value.endLine < value.line ||
            value.endLine >= value.line + requestedCount ||
            typeof value.text !== "string" ||
            !Array.isArray(value.lines) ||
            !isDeepStrictEqual(
              value.lines,
              value.text
                .split("\n")
                .map((text, index) => ({ line: value.line + index, text })),
            ) ||
            value.endLine !== value.line + value.lines.length - 1 ||
            !sources.has(file)
          )
            fail("gateway-read-invalid");
          else {
            const read = {
              evidenceId: id,
              file,
              line: value.line,
              endLine: value.endLine,
            };
            result.reads.push(read);
            reads.set(id, read);
          }
        }
        if (!executed || integrity?.verified !== true) continue;
        if (
          call.tool === "evaluation_native" &&
          nativeComplete(value, expected)
        )
          result.native.push(id);
        if (
          call.tool === "checktrail_validate" &&
          validationComplete(value, expected)
        )
          result.validations.push(id);
        if (call.tool === "evaluation_probe" && boundedExecution(value, [0])) {
          const ids = call.arguments.sourceEvidenceIds;
          if (
            !probeEvidenceIds.safeParse(ids).success ||
            ids.some((id) => !reads.has(id))
          )
            continue;
          const files = [
            ...new Set(ids.map((id) => reads.get(id).file)),
          ].sort();
          if (
            !isDeepStrictEqual(
              value.sourceFiles,
              files.map((file) => ({ file, sha256: sources.get(file) })),
            )
          ) {
            fail("gateway-probe-source-mismatch");
            continue;
          }
          result.probes.push(id);
          result.probeSources[id] = files;
        }
      } else fail("gateway-record-type-or-order-invalid");
    }
    if (pending) fail("gateway-call-result-missing");
    if (
      end.calls !== calls.length ||
      end.executionAttempts !== attempts ||
      end.verifiedExecutions !== verified ||
      end.integrityFailures !== integrityFailures
    )
      fail("gateway-counters-mismatch");
    if (end.integrityFailures !== 0) fail("gateway-execution-integrity-failed");
    if (
      calls.length > expected.budget.maxToolCalls ||
      calls.length > start.budget.maxCalls
    )
      fail("gateway-call-budget-exceeded");
    if (analysis) {
      const dispatched = [];
      for (const tool of analysis.tools) {
        if (meter.client === "claude" && tool.name === "StructuredOutput")
          continue;
        const match = /^mcp__eval__(.+)$/.exec(tool.name);
        if (
          !match ||
          !tools.has(match[1]) ||
          (!expected.treatment && match[1].startsWith("checktrail_"))
        ) {
          fail("client-unexpected-tool");
          continue;
        }
        dispatched.push({ tool: match[1], arguments: tool.arguments });
      }
      let index = 0;
      const normalize = (invocation) => {
        const parsed = toolArguments[invocation.tool]?.safeParse(
          invocation.arguments,
        );
        return {
          ...invocation,
          arguments: parsed?.success ? parsed.data : invocation.arguments,
        };
      };
      for (const call of calls) {
        while (
          index < dispatched.length &&
          !isDeepStrictEqual(
            normalize(dispatched[index]),
            normalize({
              tool: call.tool,
              arguments: call.arguments,
            }),
          )
        ) {
          if (
            toolArguments[dispatched[index].tool].safeParse(
              dispatched[index].arguments,
            ).success
          )
            fail("client-gateway-dispatch-missing");
          index++;
        }
        if (index === dispatched.length) {
          fail("client-gateway-dispatch-mismatch");
          break;
        }
        index++;
      }
      for (const invocation of dispatched.slice(index))
        if (
          toolArguments[invocation.tool].safeParse(invocation.arguments).success
        )
          fail("client-gateway-dispatch-missing");
    }
  } catch {
    fail("protocol-evidence-malformed");
  }
  result.complete = problems.length === 0;
  return result;
}
