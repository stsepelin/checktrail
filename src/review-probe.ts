import { parseCapturedProcessOutput } from "./process-output.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import {
  open,
  readFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReviewContext,
  parseReviewContext,
  receiveReview,
} from "./review.js";
import { reviewCandidateSchema } from "./review-provider-schema.js";
import { runProcess } from "./runner.js";
import { VERSION } from "./types.js";
import {
  reviewNativeBudgetLimitsSchema,
  type ReviewNativeBudgetLimits,
  reviewProbeRecipeSchema,
  reviewProbeRunSchema,
  reviewProbeSummarySchema,
  reviewProbeWireSchema,
  reviewJsonProbeWireSchema,
  type ReviewProbeRun,
} from "./review-probe-schema.js";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export interface PinnedReviewProbe {
  contents: string;
  sha256: string;
}
export interface ReviewProbeOptions {
  trusted: boolean;
  recipe: PinnedReviewProbe;
  timeoutMs: number;
  maxOutputBytes?: number;
  nativeBudget?: ReviewNativeBudgetLimits;
  signal?: AbortSignal;
}
export function parseReviewProbe(input: PinnedReviewProbe) {
  if (
    typeof input.contents !== "string" ||
    Buffer.byteLength(input.contents) > 65_536 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    hash(input.contents) !== input.sha256
  )
    throw new Error("Operator probe recipe integrity mismatch");
  const recipe = reviewProbeRecipeSchema.parse(JSON.parse(input.contents));
  if (recipe.profile === "node-export-json-v1")
    for (const item of recipe.cases) validateJsonProbeValue(item.expected);
  const roles = new Set(recipe.cases.map((item) => item.role));
  if (
    new Set(recipe.cases.map((item) => item.id)).size !== recipe.cases.length ||
    roles.size !== 3 ||
    (recipe.guard && recipe.guard.end <= recipe.guard.start)
  )
    throw new Error(
      "Probe requires distinct baseline trigger and near-miss controls and a valid guard range",
    );
  return recipe;
}
export function reviewProbeInputScale(args: unknown[]): number {
  let maximum = 1;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 16) throw new Error("Probe arguments exceed depth limit");
    if (Array.isArray(value)) {
      maximum = Math.max(maximum, value.length);
      for (const child of value) visit(child, depth + 1);
    } else if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const value of args) visit(value, 0);
  return maximum;
}
export async function runReviewProbe(
  root: string,
  contextInput: unknown,
  candidateInput: unknown,
  options: ReviewProbeOptions,
): Promise<ReviewProbeRun> {
  if (!options.trusted)
    throw new Error(
      "Native review probes require operator project-execution trust",
    );
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  )
    throw new Error("Invalid native probe wall budget");
  const maxOutputBytes = options.maxOutputBytes ?? 65_536;
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1_048_576
  )
    throw new Error("Invalid native probe output budget");
  const timeoutMs = options.timeoutMs;
  const pinned = { ...options.recipe };
  const limits = reviewNativeBudgetLimitsSchema.parse(
    options.nativeBudget ?? {
      maxCalls: 16,
      maxOutputBytes,
    },
  );
  const nativeBudget = {
    scope: "native-probe-run" as const,
    limits: {
      ...limits,
      wallMs: timeoutMs,
      maxCallOutputBytes: maxOutputBytes,
    },
    calls: 0,
    outputBytes: 0,
    stopReason: "none" as "none" | "call-limit" | "output-limit",
    outputByteCeilingGuaranteed: false as const,
  };
  const started = performance.now();
  const recipe = parseReviewProbe(pinned);
  const candidate = reviewCandidateSchema.parse(candidateInput);
  const context = parseReviewContext(contextInput);
  if (
    context.schemaVersion !== 4 &&
    context.schemaVersion !== 5 &&
    context.schemaVersion !== 6
  )
    throw new Error("Native probes require context version 4, 5 or 6");
  if (recipe.family !== candidate.family)
    throw new Error("Probe does not address the candidate family");
  const target = context.files.find((file) => file.path === recipe.file);
  const definitions = context.analysis.functions.filter(
    (fn) =>
      fn.revision === "current" &&
      fn.file === recipe.file &&
      fn.name === recipe.exportName &&
      fn.kind === "function",
  );
  if (
    !target ||
    definitions.length !== 1 ||
    !candidate.citations.some(
      (citation) =>
        citation.revision === "current" &&
        citation.file === recipe.file &&
        citation.sourceDigest === target.sha256 &&
        citation.startLine <= definitions[0]!.endLine &&
        citation.endLine >= definitions[0]!.startLine,
    )
  )
    throw new Error(
      "Probe export and candidate require one selected current function address",
    );
  const definition = definitions[0]!;
  if (
    recipe.guard &&
    (recipe.guard.start < definition.start || recipe.guard.end > definition.end)
  )
    throw new Error("Probe guard range is outside the current function");
  const candidateObservation = {
    id: candidate.id,
    severity: candidate.severity,
    claim: candidate.claim,
    citations: candidate.citations,
    attribution: candidate.attribution,
    fixScope: candidate.fixScope,
  };
  const receipt = await receiveReview(root, context, {
    schemaVersion: 2,
    contextDigest: context.contextDigest,
    reviewer: { kind: "human", name: "Operator native probe binding" },
    createdAt: new Date().toISOString(),
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: [],
    observations: [candidateObservation],
  });
  if (receipt.citations.unmatched)
    throw new Error(
      "Native probe citations must match assigned source exactly",
    );
  const trials: Array<
    Extract<ReviewProbeRun, { schemaVersion: 3 | 4 }>["trials"][number]
  > = recipe.cases.map((item) => ({
    id: item.id,
    role: item.role,
    status: "not-run",
    reason: "not-started",
    inputScale: reviewProbeInputScale(item.args),
    functionExecuted: false,
    guardCoverage: recipe.guard ? "unknown" : "not-requested",
    expected: item.expected,
    actual: null,
    matchesExpectation: null,
    durationMs: 0,
    ranges: [],
    execution: null,
  }));
  const supported =
    process.platform !== "win32" &&
    context.files.every((file) => /\.(?:js|mjs)$/.test(file.path)) &&
    context.analysis.files
      .filter((file) => file.revision === "current")
      .every((file) => file.state === "collected") &&
    context.analysis.modules
      .filter((module) => module.revision === "current")
      .every((module) => module.resolution === "selected");
  let status: ReviewProbeRun["status"] =
    receipt.freshness === "stale"
      ? "stale"
      : supported
        ? "incomplete"
        : "unsupported";
  let freshness: ReviewProbeRun["freshness"];
  if (options.signal?.aborted) status = "cancelled";
  let nativeExecution = false;
  let temporary: string | undefined;
  let temporaryArtifacts: ReviewProbeRun["temporaryArtifacts"] = "not-created";
  const workerBytes = await readFile(
    fileURLToPath(
      new URL(
        recipe.profile === "node-export-json-v1"
          ? "./review-json-probe-worker.js"
          : "./review-probe-worker.js",
        import.meta.url,
      ),
    ),
  );
  const workerDigest = createHash("sha256").update(workerBytes).digest("hex");
  try {
    if (status === "incomplete" && supported) {
      for (const [index, trial] of trials.entries()) {
        let remaining = Math.floor(timeoutMs - (performance.now() - started));
        if (options.signal?.aborted) {
          status = "cancelled";
          trial.reason = "cancelled";
          break;
        }
        if (remaining < 1) {
          status = "timed-out";
          trial.reason = "timeout";
          break;
        }
        if (
          nativeBudget.calls >= limits.maxCalls ||
          nativeBudget.outputBytes >= limits.maxOutputBytes
        ) {
          nativeBudget.stopReason =
            nativeBudget.calls >= limits.maxCalls
              ? "call-limit"
              : "output-limit";
          trial.reason =
            nativeBudget.stopReason === "call-limit"
              ? "call-limit"
              : "output-budget";
          break;
        }
        temporary ??= await realpath(
          await mkdtemp(path.join(tmpdir(), "checktrail-probe-")),
        );
        const caseRoot = path.join(temporary, `case-${index}`);
        await mkdir(path.join(caseRoot, "source"), { recursive: true });
        await writeFile(
          path.join(caseRoot, "source/package.json"),
          JSON.stringify({ type: "module" }),
          { mode: 0o600 },
        );
        for (const file of context.files) {
          const destination = path.join(caseRoot, "source", file.path);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, file.content, { mode: 0o600 });
        }
        const workerFile = path.join(caseRoot, "worker.mjs");
        await writeFile(workerFile, workerBytes, { mode: 0o600 });
        const request = JSON.stringify({
          file: recipe.file,
          exportName: recipe.exportName,
          args: recipe.cases[index]!.args,
        });
        const requestFile = path.join(caseRoot, "request.json");
        await writeFile(requestFile, request, { mode: 0o600 });
        // Copying assigned sources is part of the wall budget, not a new allowance.
        remaining = Math.floor(timeoutMs - (performance.now() - started));
        if (options.signal?.aborted || remaining < 1) {
          status = options.signal?.aborted ? "cancelled" : "timed-out";
          trial.reason = options.signal?.aborted ? "cancelled" : "timeout";
          break;
        }
        const outputLimitBytes = Math.min(
          maxOutputBytes,
          limits.maxOutputBytes - nativeBudget.outputBytes,
        );
        const call = ++nativeBudget.calls;
        const result = await runProcess(
          caseRoot,
          {
            executable: process.execPath,
            args: ["--no-addons", "--no-warnings", workerFile, requestFile],
            cwd: ".",
          },
          {
            timeoutMs: Math.min(120_000, remaining),
            maxOutputBytes: outputLimitBytes,
            captureRawOutput: true,
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        nativeExecution ||= result.exitCode !== null || result.signal !== null;
        const outputBytes = result.outputBytes;
        nativeBudget.outputBytes += outputBytes;
        trial.execution = {
          call,
          outputLimitBytes,
          outputBytes,
          truncated: result.truncated,
          artifact: {
            profile: "native-probe-process-attempt-v1",
            requestDigest: hash(request),
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            truncated: result.truncated,
            errorCode: result.errorCode ?? null,
            output: result.capturedOutput ?? null,
          },
        };
        if (result.truncated) nativeBudget.stopReason = "output-limit";
        trial.durationMs = Math.round(result.durationMs);
        try {
          await rm(caseRoot, { recursive: true, force: true });
        } catch {
          // Keep the invocation/byte receipt and stop before another case starts.
          trial.status = "unresolved";
          trial.reason = "cleanup-failed";
          break;
        }
        if (
          result.cancelled ||
          result.timedOut ||
          result.truncated ||
          result.errorCode ||
          result.exitCode !== 0 ||
          result.signal ||
          result.stderr ||
          !result.capturedOutput ||
          !result.capturedOutput.completeForObservedStreams
        ) {
          trial.status = "unresolved";
          trial.reason = result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "timeout"
              : result.truncated
                ? "output-limit"
                : "runtime-error";
          if (result.cancelled || result.timedOut) {
            status = result.cancelled ? "cancelled" : "timed-out";
            break;
          }
          if (result.truncated) {
            nativeBudget.stopReason = "output-limit";
            break;
          }
          continue;
        }
        try {
          const evidence = parseProbeWire(
            JSON.parse(result.stdout),
            recipe.profile,
          );
          const nativeRange = evidence.functionRange;
          if (
            evidence.requestDigest !== hash(request) ||
            evidence.sourceDigest !== target.sha256 ||
            nativeRange.start < definition.start ||
            nativeRange.end > definition.end ||
            nativeRange.end <= nativeRange.start ||
            evidence.ranges.some(
              (range) =>
                range.start < nativeRange.start ||
                range.end > nativeRange.end ||
                range.end <= range.start,
            ) ||
            !evidence.ranges.some(
              (range) =>
                range.start === nativeRange.start &&
                range.end === nativeRange.end &&
                range.count > 0,
            )
          )
            throw new Error(
              "Native coverage does not match the assigned function",
            );
          trial.functionExecuted = true;
          trial.actual = evidence.actual;
          trial.matchesExpectation = isDeepStrictEqual(
            evidence.actual,
            trial.expected,
          );
          trial.ranges = evidence.ranges;
          // V8 compresses equal-count child blocks into their enclosing range.
          // An exact block boundary must appear in another trial below; this
          // trial inherits the count of its smallest enclosing native range.
          const guard = recipe.guard
            ? evidence.ranges
                .filter(
                  (range) =>
                    range.start <= recipe.guard!.start &&
                    range.end >= recipe.guard!.end,
                )
                .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
            : undefined;
          const partialGuard =
            recipe.guard &&
            guard &&
            evidence.ranges.some(
              (range) =>
                range.start < recipe.guard!.end &&
                range.end > recipe.guard!.start &&
                !(
                  range.start <= recipe.guard!.start &&
                  range.end >= recipe.guard!.end
                ) &&
                range.count !== guard.count,
            );
          trial.guardCoverage = recipe.guard
            ? guard && !partialGuard
              ? guard.count > 0
                ? "executed"
                : "not-executed"
              : "unknown"
            : "not-requested";
          trial.status = "observed";
          trial.reason =
            recipe.profile === "node-export-json-v1"
              ? "json-observed"
              : "boolean-observed";
          if (
            trial.role === "trigger" &&
            trial.inputScale < recipe.minimumTriggerScale
          ) {
            trial.status = "unresolved";
            trial.reason = "scale-not-met";
          } else if (
            trial.role === "trigger" &&
            recipe.guard &&
            trial.guardCoverage !== "executed"
          ) {
            trial.status = "unresolved";
            trial.reason = "guard-not-covered";
          }
        } catch {
          trial.status = "unresolved";
          trial.reason = "malformed-evidence";
        }
      }
      if (
        recipe.guard &&
        !trials.some((trial) =>
          trial.ranges.some(
            (range) =>
              range.start === recipe.guard!.start &&
              range.end === recipe.guard!.end,
          ),
        )
      ) {
        for (const trial of trials.filter(
          (trial) => trial.role === "trigger" && trial.status === "observed",
        )) {
          trial.status = "unresolved";
          trial.reason = "guard-not-covered";
          trial.guardCoverage = "unknown";
        }
      }
      if (trials.every((trial) => trial.status === "observed"))
        status = "completed";
    }
    try {
      freshness =
        (await createReviewContext(root, context.selection)).contextDigest ===
        context.contextDigest
          ? "current"
          : "stale";
    } catch {
      freshness = "stale";
    }
    if (freshness === "stale") status = "stale";
  } finally {
    if (temporary) {
      try {
        await rm(temporary, { recursive: true, force: true });
        temporaryArtifacts = "removed";
      } catch {
        temporaryArtifacts = "cleanup-failed";
        status = "incomplete";
      }
    }
  }
  if (options.signal?.aborted && status !== "stale") status = "cancelled";
  if (
    performance.now() - started > timeoutMs &&
    (status === "completed" || status === "incomplete")
  )
    status = "timed-out";
  const counts = {
    selected: trials.length,
    observed: trials.filter((trial) => trial.status === "observed").length,
    unresolved: trials.filter((trial) => trial.status === "unresolved").length,
    notRun: trials.filter((trial) => trial.status === "not-run").length,
    triggerMismatches: trials.filter(
      (trial) =>
        trial.role === "trigger" &&
        trial.status === "observed" &&
        trial.matchesExpectation === false,
    ).length,
    controlMismatches: trials.filter(
      (trial) =>
        trial.role !== "trigger" &&
        trial.status === "observed" &&
        trial.matchesExpectation === false,
    ).length,
  };
  return parseReviewProbeRun({
    schemaVersion: recipe.profile === "node-export-json-v1" ? 4 : 3,
    nativeBudget,
    format: "review-probe-run",
    engineVersion: VERSION,
    channel: "advisory",
    claimsVerified: false,
    deterministicOutcomeChanged: false,
    nativeExecution,
    executionSandboxed: false,
    profile: recipe.profile,
    recipeDigest: pinned.sha256,
    workerDigest,
    sourceDigest: target.sha256,
    functionRange: { start: definition.start, end: definition.end },
    minimumTriggerScale: recipe.minimumTriggerScale,
    guard: recipe.guard,
    contextDigest: context.contextDigest,
    candidateDigest: hash(JSON.stringify(candidate)),
    runtime: { name: "node", version: process.versions.node },
    status,
    behavior:
      status !== "completed" || counts.controlMismatches
        ? "unresolved"
        : counts.triggerMismatches
          ? "violated"
          : "satisfied",
    requirementProvenance: "operator-pinned-expectations",
    callerReachability: "not-established",
    mechanismVerified: false,
    fixVerified: false,
    freshness,
    temporaryArtifacts,
    counts,
    trials,
  });
}
function reconcileNativeBudget(
  run: Extract<ReviewProbeRun, { schemaVersion: 2 | 3 | 4 }>,
): void {
  const budget = run.nativeBudget;
  let calls = 0,
    bytes = 0;
  let stopped = false;
  let expectedStop: typeof budget.stopReason = "none";
  for (const trial of run.trials) {
    const execution = trial.execution;
    if (!execution) {
      if (
        trial.status !== "not-run" ||
        trial.durationMs !== 0 ||
        trial.functionExecuted ||
        trial.actual !== null ||
        trial.matchesExpectation !== null ||
        trial.ranges.length
      )
        throw new Error("Unstarted native trial cannot retain observations");
      if (!stopped) {
        if (trial.reason === "call-limit") {
          if (calls < budget.limits.maxCalls)
            throw new Error("Native call budget was not exhausted");
          expectedStop = "call-limit";
        } else if (trial.reason === "output-budget") {
          if (
            bytes < budget.limits.maxOutputBytes ||
            calls >= budget.limits.maxCalls
          )
            throw new Error("Native output budget was not exhausted");
          expectedStop = "output-limit";
        } else if (
          trial.reason === "not-started" &&
          run.status === "incomplete" &&
          (calls >= budget.limits.maxCalls ||
            bytes >= budget.limits.maxOutputBytes)
        )
          throw new Error("Native admission stop reason is missing");
      } else if (trial.reason !== "not-started")
        throw new Error(
          "Unstarted native trial cannot change a prior stop reason",
        );
      stopped = true;
      continue;
    }
    const remaining = budget.limits.maxOutputBytes - bytes;
    if (
      stopped ||
      calls >= budget.limits.maxCalls ||
      remaining < 1 ||
      execution.call !== ++calls ||
      execution.outputLimitBytes !==
        Math.min(budget.limits.maxCallOutputBytes, remaining) ||
      execution.truncated !==
        execution.outputBytes > execution.outputLimitBytes ||
      trial.status === "not-run" ||
      (execution.truncated &&
        (trial.status !== "unresolved" ||
          !["output-limit", "cancelled", "timeout", "cleanup-failed"].includes(
            trial.reason,
          )))
    )
      throw new Error("Native trial admission does not reconcile");
    bytes += execution.outputBytes;
    if (execution.truncated) {
      stopped = true;
      expectedStop = "output-limit";
    }
    if (["cancelled", "timeout", "cleanup-failed"].includes(trial.reason))
      stopped = true;
  }
  if (
    budget.calls !== calls ||
    budget.outputBytes !== bytes ||
    budget.stopReason !== expectedStop ||
    (budget.stopReason !== "none" && run.status === "completed")
  )
    throw new Error("Native run budget does not reconcile");
}
function reconcileNativeOutput(
  run: Extract<ReviewProbeRun, { schemaVersion: 3 | 4 }>,
): void {
  for (const trial of run.trials) {
    const execution = trial.execution;
    if (!execution) continue;
    const artifact = execution.artifact;
    if (artifact.truncated !== execution.truncated)
      throw new Error("Native attempt truncation flags disagree");
    const output = artifact.output
      ? parseCapturedProcessOutput(artifact.output)
      : null;
    if (
      output &&
      (output.observedBytes !== execution.outputBytes ||
        output.stdout.bytes + output.stderr.bytes >
          execution.outputLimitBytes ||
        (execution.truncated && output.completeForObservedStreams))
    )
      throw new Error("Native attempt physical byte accounting disagrees");
    if (
      trial.status === "observed" &&
      (!output ||
        !output.completeForObservedStreams ||
        artifact.exitCode !== 0 ||
        artifact.signal ||
        artifact.errorCode ||
        artifact.timedOut ||
        artifact.cancelled ||
        artifact.truncated ||
        output.stderr.bytes !== 0)
    )
      throw new Error(
        "Unusable native attempt cannot supply an observed claim",
      );
    if (trial.functionExecuted) {
      if (
        !output ||
        !output.completeForObservedStreams ||
        artifact.exitCode !== 0 ||
        artifact.signal ||
        artifact.errorCode ||
        artifact.timedOut ||
        artifact.cancelled ||
        artifact.truncated ||
        output.stderr.bytes !== 0
      )
        throw new Error(
          "Native function observation lacks usable complete physical output",
        );
      const wire = parseProbeWire(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.from(output.stdout.base64, "base64"),
          ),
        ),
        run.profile,
      );
      if (
        wire.requestDigest !== artifact.requestDigest ||
        wire.sourceDigest !== run.sourceDigest ||
        (run.schemaVersion === 4
          ? !isDeepStrictEqual(wire.actual, trial.actual)
          : wire.actual !== trial.actual) ||
        !isDeepStrictEqual(wire.ranges, trial.ranges) ||
        wire.functionRange.start < run.functionRange.start ||
        wire.functionRange.end > run.functionRange.end
      )
        throw new Error(
          "Native parsed observation disagrees with retained process output",
        );
    }
  }
}
export function parseReviewProbeRun(input: unknown): ReviewProbeRun {
  const run = reviewProbeRunSchema.parse(input);
  if (run.schemaVersion !== 1) reconcileNativeBudget(run);
  if (run.schemaVersion === 3 || run.schemaVersion === 4)
    reconcileNativeOutput(run);
  if (run.schemaVersion === 4) {
    for (const trial of run.trials) {
      validateJsonProbeValue(trial.expected);
      if (trial.functionExecuted) validateJsonProbeValue(trial.actual);
    }
  }
  const counts = run.counts;
  if (
    counts.selected !== run.trials.length ||
    counts.selected !== counts.observed + counts.unresolved + counts.notRun ||
    counts.observed !==
      run.trials.filter((trial) => trial.status === "observed").length ||
    counts.unresolved !==
      run.trials.filter((trial) => trial.status === "unresolved").length ||
    counts.notRun !==
      run.trials.filter((trial) => trial.status === "not-run").length ||
    (run.status !== "completed" && run.behavior !== "unresolved")
  )
    throw new Error("Native probe accounting does not reconcile");
  if (
    run.functionRange.end <= run.functionRange.start ||
    (run.guard &&
      (run.guard.start < run.functionRange.start ||
        run.guard.end > run.functionRange.end ||
        run.guard.end <= run.guard.start))
  )
    throw new Error("Native probe ranges do not match the function binding");
  const observed = run.trials.filter((trial) => trial.status === "observed");
  for (const trial of observed) {
    const top = trial.ranges[0];
    if (
      !top ||
      top.count < 1 ||
      top.start < run.functionRange.start ||
      top.end > run.functionRange.end ||
      trial.ranges.some(
        (range) =>
          range.start < top.start ||
          range.end > top.end ||
          range.end <= range.start,
      ) ||
      (trial.role === "trigger" && trial.inputScale < run.minimumTriggerScale)
    )
      throw new Error("Native probe coverage and scale do not reconcile");
    if (!run.guard) {
      if (trial.guardCoverage !== "not-requested")
        throw new Error("Native probe guard was not selected");
    } else {
      const enclosing = trial.ranges
        .filter(
          (range) =>
            range.start <= run.guard!.start && range.end >= run.guard!.end,
        )
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      const partial =
        enclosing &&
        trial.ranges.some(
          (range) =>
            range.start < run.guard!.end &&
            range.end > run.guard!.start &&
            !(range.start <= run.guard!.start && range.end >= run.guard!.end) &&
            range.count !== enclosing.count,
        );
      const expected =
        enclosing && !partial
          ? enclosing.count > 0
            ? "executed"
            : "not-executed"
          : "unknown";
      if (
        trial.guardCoverage !== expected ||
        (trial.role === "trigger" &&
          (expected !== "executed" ||
            !run.trials.some((item) =>
              item.ranges.some(
                (range) =>
                  range.start === run.guard!.start &&
                  range.end === run.guard!.end,
              ),
            )))
      )
        throw new Error("Native probe guard coverage is not established");
    }
  }
  const controls = observed.filter(
    (trial) => trial.role !== "trigger" && trial.matchesExpectation === false,
  ).length;
  const triggers = observed.filter(
    (trial) => trial.role === "trigger" && trial.matchesExpectation === false,
  ).length;
  if (
    controls !== counts.controlMismatches ||
    triggers !== counts.triggerMismatches ||
    new Set(run.trials.map((trial) => trial.id)).size !== run.trials.length ||
    observed.some(
      (trial) =>
        !trial.functionExecuted ||
        (run.schemaVersion !== 4 && trial.actual === null) ||
        trial.matchesExpectation !==
          isDeepStrictEqual(trial.actual, trial.expected) ||
        trial.reason !==
          (run.schemaVersion === 4 ? "json-observed" : "boolean-observed"),
    )
  )
    throw new Error("Native probe observations do not reconcile");
  if (
    run.status === "completed" &&
    (!run.nativeExecution ||
      run.freshness !== "current" ||
      run.temporaryArtifacts !== "removed" ||
      counts.selected !== counts.observed ||
      new Set(run.trials.map((trial) => trial.role)).size !== 3)
  )
    throw new Error("Incomplete native probe evidence cannot be complete");
  const behavior =
    run.status !== "completed" || controls
      ? "unresolved"
      : triggers
        ? "violated"
        : "satisfied";
  if (!isDeepStrictEqual(run.behavior, behavior))
    throw new Error("Native probe behavior does not match its controls");
  return run;
}
export function projectReviewProbe(
  input: ReviewProbeRun,
  detailed: boolean,
): Record<string, unknown> {
  const run = parseReviewProbeRun(input);
  if (detailed) return run;
  const { trials, ...metadata } = run;
  void trials;
  return reviewProbeSummarySchema.parse({ ...metadata, sourceIncluded: false });
}

export async function loadPinnedReviewProbe(
  reference: string,
): Promise<PinnedReviewProbe> {
  const separator = reference.lastIndexOf("#sha256=");
  if (separator < 1)
    throw new Error("Operator probe registration requires PATH#sha256=DIGEST");
  const file = path.resolve(reference.slice(0, separator));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65_536)
      throw new Error("Operator probe recipe must be a bounded regular file");
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const pinned = {
      contents: new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      ),
      sha256: reference.slice(separator + 8),
    };
    parseReviewProbe(pinned);
    return pinned;
  } finally {
    await handle.close();
  }
}

function validateJsonProbeValue(input: unknown): void {
  const queue = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (++nodes > 1024 || depth > 16)
      throw new Error("Probe JSON value exceeds structural limits");
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || Object.is(value, -0))
    )
      throw new Error("Probe JSON number is not lossless");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value))
        queue.push({ value: child, depth: depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 16384)
    throw new Error("Probe JSON value exceeds physical value byte limit");
}
function parseProbeWire(input: unknown, profile: ReviewProbeRun["profile"]) {
  if (profile === "node-export-json-v1") {
    const wire = reviewJsonProbeWireSchema.parse(input);
    validateJsonProbeValue(wire.actual);
    return wire;
  }
  return reviewProbeWireSchema.parse(input);
}
