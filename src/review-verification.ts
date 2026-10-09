import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createReviewContext,
  parseReviewContext,
  reviewContextSchema,
} from "./review.js";
import {
  reviewCandidateSchema,
  reviewProviderConfigSchema,
  reviewProviderRunSchema,
  reviewProviderSummarySchema,
} from "./review-provider-schema.js";
import {
  runProviderAdjudicationAssignment,
  parseProviderReview,
  projectProviderReview,
  createRefutationPacket,
  type ReviewProviderOptions,
} from "./review-provider.js";
import {
  runProviderRefutation,
  parseProviderRefutation,
  projectProviderRefutation,
  reviewRefutationRunSchema,
  reviewRefutationSummarySchema,
} from "./review-refutation.js";
import {
  runReviewProbe,
  parseReviewProbe,
  parseReviewProbeRun,
  projectReviewProbe,
  reviewProbeInputScale,
  type PinnedReviewProbe,
} from "./review-probe.js";
import {
  reviewNativeBudgetLimitsSchema,
  type ReviewNativeBudgetLimits,
  reviewProbeRunSchema,
  reviewProbeSummarySchema,
} from "./review-probe-schema.js";
import {
  createAdjudicationPacket,
  adjudicationDigest as hash,
} from "./review-adjudication.js";
import { createHash } from "node:crypto";
import { VERSION } from "./types.js";
import { shareProviderRunBudget } from "./review-provider-aggregate.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  format: z.literal("review-verification-run"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  claimsVerified: z.literal(false),
  deterministicOutcomeChanged: z.literal(false),
  resolution: z.literal("unresolved"),
  severity: z.literal("unassigned"),
  severityBasis: z.literal("consequence-not-established"),
  contextDigest: digest,
  targetDigest: digest,
  recipeDigest: digest,
  refutationDigest: digest,
  probeDigest: digest.nullable(),
  adjudicationDigest: digest.nullable(),
  status: z.enum([
    "completed",
    "incomplete",
    "stale",
    "cancelled",
    "timed-out",
  ]),
  stopReason: z.enum([
    "completed",
    "refutation-incomplete",
    "probe-incomplete",
    "adjudication-incomplete",
    "stale",
    "cancelled",
    "timed-out",
  ]),
  freshness: z.enum(["current", "stale"]),
  evidenceTier: z.enum([
    "native-expectation-mismatch",
    "native-controls-observed",
    "no-current-native-evidence",
  ]),
  budgetScope: z.enum(["per-provider-assignment", "verification-run"]),
  independence: z.strictObject({
    refuterNativeEvidence: z.literal(false),
    adjudicatorInput: z.literal(
      "raw-native-observations-and-unverified-hypotheses",
    ),
    priorProviderIdentities: z.literal(false),
    priorSeverityAndConfidence: z.literal(false),
    priorVerdicts: z.literal(false),
    sessions: z.literal("fresh-stateless-inline-api"),
  }),
  mechanism: z.literal("not-established"),
  callerReachability: z.literal("not-established"),
  intendedPolicy: z.literal("not-established"),
  consequence: z.literal("not-established"),
  fixFeasibility: z.literal("not-established"),
};
const legacyLimits = z.strictObject({
  wallMs: z.number().int().min(1).max(120000),
  maxNativeOutputBytes: z.number().int().min(1).max(1048576),
});
const limitsSchema = legacyLimits.extend({
  nativeBudget: reviewNativeBudgetLimitsSchema,
});
const retained = {
  ...common,
  context: reviewContextSchema,
  target: reviewCandidateSchema,
  recipe: z.strictObject({ contents: z.string().max(65536), sha256: digest }),
  refutation: reviewRefutationRunSchema,
  probe: reviewProbeRunSchema.nullable(),
  adjudication: reviewProviderRunSchema.nullable(),
};
export const reviewVerificationRunSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    z.strictObject({
      ...retained,
      schemaVersion: z.literal(1),
      limits: legacyLimits,
    }),
    z.strictObject({
      ...retained,
      schemaVersion: z.literal(2),
      limits: limitsSchema,
    }),
  ],
);
const summary = {
  ...common,
  refutation: reviewRefutationSummarySchema,
  probe: reviewProbeSummarySchema.nullable(),
  adjudication: reviewProviderSummarySchema.nullable(),
  sourceIncluded: z.literal(false),
};
export const reviewVerificationSummarySchema = z.discriminatedUnion(
  "schemaVersion",
  [
    z.strictObject({
      ...summary,
      schemaVersion: z.literal(1),
      limits: legacyLimits,
    }),
    z.strictObject({
      ...summary,
      schemaVersion: z.literal(2),
      limits: limitsSchema,
    }),
  ],
);
export type ReviewVerificationRun = z.infer<typeof reviewVerificationRunSchema>;
export interface ReviewVerificationOptions {
  trusted: boolean;
  recipe: PinnedReviewProbe;
  wallMs: number;
  maxNativeOutputBytes?: number;
  nativeBudget?: ReviewNativeBudgetLimits;
  provider: ReviewProviderOptions;
  signal?: AbortSignal;
}
const byteHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
function inputs(
  contextInput: unknown,
  targetInput: unknown,
  pinned: PinnedReviewProbe,
) {
  const context = parseReviewContext(contextInput);
  const target = reviewCandidateSchema.parse(targetInput);
  const recipe = parseReviewProbe(pinned);
  if (
    context.schemaVersion !== 4 &&
    context.schemaVersion !== 5 &&
    context.schemaVersion !== 6 &&
    context.schemaVersion !== 7 &&
    context.schemaVersion !== 8 &&
    context.schemaVersion !== 9 &&
    context.schemaVersion !== 10 &&
    context.schemaVersion !== 11 &&
    context.schemaVersion !== 12
  )
    throw new Error(
      "Verification requires context version 4, 5, 6, 7, 8, 9, 10, 11 or 12",
    );
  if (recipe.family !== target.family)
    throw new Error("Verification probe family does not match target");
  if (context.evidence.track === "snapshot" && target.attribution !== "unknown")
    throw new Error("Snapshot cannot establish historical attribution");
  for (const citation of target.citations) {
    const file = (
      citation.revision === "base" && context.evidence.track === "diff"
        ? context.evidence.baseFiles
        : citation.revision === "current"
          ? context.files
          : []
    ).find((item) => item.path === citation.file);
    if (
      !file ||
      citation.sourceDigest !== file.sha256 ||
      citation.endLine < citation.startLine ||
      citation.endLine > file.content.split("\n").length ||
      file.content
        .split("\n")
        .slice(citation.startLine - 1, citation.endLine)
        .join("\n") !== citation.quote
    )
      throw new Error(
        "Verification target quotation does not match assigned source",
      );
  }
  const file = context.files.find((item) => item.path === recipe.file);
  const definitions = context.analysis.functions.filter(
    (fn) =>
      fn.revision === "current" &&
      fn.file === recipe.file &&
      fn.name === recipe.exportName &&
      fn.kind === "function",
  );
  const definition = definitions[0];
  if (
    !file ||
    definitions.length !== 1 ||
    !definition ||
    !target.citations.some(
      (citation) =>
        citation.revision === "current" &&
        citation.file === recipe.file &&
        citation.startLine <= definition.endLine &&
        citation.endLine >= definition.startLine,
    ) ||
    (recipe.guard &&
      (recipe.guard.start < definition.start ||
        recipe.guard.end > definition.end))
  )
    throw new Error(
      "Verification requires one exactly cited current function and an in-scope guard",
    );
  // Resolve argument depth/scale before either disclosure or native execution.
  recipe.cases.forEach((item) => reviewProbeInputScale(item.args));
  return { context, target, recipe, file, definition };
}
function readyProbe(probe: ReviewVerificationRun["probe"]): boolean {
  return (
    probe !== null &&
    probe.status === "completed" &&
    probe.freshness === "current" &&
    probe.temporaryArtifacts === "removed" &&
    probe.behavior !== "unresolved"
  );
}
function tier(
  probe: ReviewVerificationRun["probe"],
  freshness: ReviewVerificationRun["freshness"],
): ReviewVerificationRun["evidenceTier"] {
  return freshness === "current" && readyProbe(probe)
    ? probe!.behavior === "violated"
      ? "native-expectation-mismatch"
      : "native-controls-observed"
    : "no-current-native-evidence";
}
function incompleteReason(
  refutation: ReviewVerificationRun["refutation"],
  probe: ReviewVerificationRun["probe"],
  adjudication: ReviewVerificationRun["adjudication"],
): ReviewVerificationRun["stopReason"] {
  return refutation.verifier.status !== "completed"
    ? "refutation-incomplete"
    : !readyProbe(probe)
      ? "probe-incomplete"
      : adjudication?.status !== "completed"
        ? "adjudication-incomplete"
        : "completed";
}
export async function runReviewVerification(
  root: string,
  contextInput: unknown,
  targetInput: unknown,
  options: ReviewVerificationOptions,
): Promise<ReviewVerificationRun> {
  if (
    !options.trusted ||
    !options.provider.allowInference ||
    !options.provider.allowSourceDisclosure
  )
    throw new Error(
      "Verification requires operator execution, inference and provider-source grants",
    );
  const limits = limitsSchema.parse({
    wallMs: options.wallMs,
    maxNativeOutputBytes: options.maxNativeOutputBytes ?? 65536,
    nativeBudget: options.nativeBudget ?? {
      maxCalls: 16,
      maxOutputBytes: options.maxNativeOutputBytes ?? 65536,
    },
  });
  const { context, target, recipe } = inputs(
    contextInput,
    targetInput,
    options.recipe,
  );
  // Freeze operator and source inputs across awaits; no caller mutation can swap the recipe or config mid-run.
  const pinned = {
    contents: options.recipe.contents,
    sha256: options.recipe.sha256,
  };
  const config = reviewProviderConfigSchema.parse(options.provider.config);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.wallMs);
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal ? [options.signal] : []),
    ...(options.provider.signal ? [options.provider.signal] : []),
  ]);
  const provider = {
    ...options.provider,
    config,
    signal,
    ...(options.provider.environment
      ? { environment: { ...options.provider.environment } }
      : {}),
  };
  shareProviderRunBudget(provider, config);
  try {
    const refutation = await runProviderRefutation(
      root,
      context,
      target,
      provider,
    );
    let probe: ReviewVerificationRun["probe"] = null;
    let adjudication: ReviewVerificationRun["adjudication"] = null;
    if (!signal.aborted && refutation.verifier.status === "completed") {
      probe = await runReviewProbe(root, context, target, {
        trusted: true,
        recipe: pinned,
        timeoutMs: limits.wallMs,
        maxOutputBytes: limits.maxNativeOutputBytes,
        nativeBudget: limits.nativeBudget,
        signal,
      });
      parseReviewProbeRun(probe);
      if (!signal.aborted && readyProbe(probe))
        adjudication = await runProviderAdjudicationAssignment(
          root,
          context,
          {
            target,
            recipe,
            probe,
            counterclaims: refutation.verifier.candidates,
          },
          provider,
        );
    }
    let freshness: ReviewVerificationRun["freshness"] = "stale";
    try {
      if (
        (await createReviewContext(root, context.selection)).contextDigest ===
          context.contextDigest &&
        refutation.verifier.freshness !== "stale" &&
        probe?.freshness !== "stale" &&
        adjudication?.freshness !== "stale"
      )
        freshness = "current";
    } catch {
      /* Missing or changed assigned bytes remain stale. */
    }
    const incomplete = incompleteReason(refutation, probe, adjudication);
    const status = timedOut
      ? "timed-out"
      : signal.aborted
        ? "cancelled"
        : freshness === "stale"
          ? "stale"
          : incomplete === "completed"
            ? "completed"
            : "incomplete";
    return parseReviewVerification({
      schemaVersion: 2,
      format: "review-verification-run",
      engineVersion: VERSION,
      channel: "advisory",
      claimsVerified: false,
      deterministicOutcomeChanged: false,
      resolution: "unresolved",
      severity: "unassigned",
      severityBasis: "consequence-not-established",
      contextDigest: context.contextDigest,
      targetDigest: hash(target),
      recipeDigest: pinned.sha256,
      refutationDigest: hash(refutation),
      probeDigest: probe ? hash(probe) : null,
      adjudicationDigest: adjudication ? hash(adjudication) : null,
      status,
      stopReason: status === "incomplete" ? incomplete : status,
      freshness,
      evidenceTier: tier(probe, freshness),
      budgetScope: config.limits.aggregateBudget
        ? "verification-run"
        : "per-provider-assignment",
      limits,
      independence: {
        refuterNativeEvidence: false,
        adjudicatorInput: "raw-native-observations-and-unverified-hypotheses",
        priorProviderIdentities: false,
        priorSeverityAndConfidence: false,
        priorVerdicts: false,
        sessions: "fresh-stateless-inline-api",
      },
      mechanism: "not-established",
      callerReachability: "not-established",
      intendedPolicy: "not-established",
      consequence: "not-established",
      fixFeasibility: "not-established",
      context,
      target,
      recipe: pinned,
      refutation,
      probe,
      adjudication,
    });
  } finally {
    clearTimeout(timer);
  }
}
/** Reconciles retained evidence, not an authenticity signature for external files. */
export function parseReviewVerification(input: unknown): ReviewVerificationRun {
  const run = reviewVerificationRunSchema.parse(input);
  const { context, target, recipe, file, definition } = inputs(
    run.context,
    run.target,
    run.recipe,
  );
  const refutation = parseProviderRefutation(run.refutation);
  if (
    run.contextDigest !== context.contextDigest ||
    run.targetDigest !== hash(target) ||
    run.recipeDigest !== run.recipe.sha256 ||
    run.refutationDigest !== hash(refutation) ||
    !isDeepStrictEqual(refutation.target, target) ||
    refutation.contextDigest !== context.contextDigest ||
    refutation.assignmentDigest !==
      byteHash(createRefutationPacket(context, target))
  )
    throw new Error("Verification refutation bindings do not reconcile");
  const probe = run.probe;
  if ((probe ? hash(probe) : null) !== run.probeDigest)
    throw new Error("Verification probe digest does not reconcile");
  if (probe) {
    parseReviewProbeRun(probe);
    if (
      run.schemaVersion === 2 &&
      (probe.schemaVersion === 1 ||
        !isDeepStrictEqual(probe.nativeBudget.limits, {
          ...run.limits.nativeBudget,
          wallMs: run.limits.wallMs,
          maxCallOutputBytes: run.limits.maxNativeOutputBytes,
        }))
    )
      throw new Error(
        "Verification native budgets do not match operator limits",
      );
    if (
      refutation.verifier.status !== "completed" ||
      probe.contextDigest !== context.contextDigest ||
      probe.candidateDigest !== hash(target) ||
      probe.recipeDigest !== run.recipe.sha256 ||
      probe.profile !== recipe.profile ||
      probe.sourceDigest !== file.sha256 ||
      probe.functionRange.start !== definition.start ||
      probe.functionRange.end !== definition.end ||
      probe.minimumTriggerScale !== recipe.minimumTriggerScale ||
      !isDeepStrictEqual(probe.guard, recipe.guard) ||
      probe.trials.length !== recipe.cases.length ||
      probe.trials.some((trial, index) => {
        const item = recipe.cases[index]!;
        return (
          trial.id !== item.id ||
          trial.role !== item.role ||
          !isDeepStrictEqual(trial.expected, item.expected) ||
          trial.inputScale !== reviewProbeInputScale(item.args)
        );
      })
    )
      throw new Error(
        "Verification native observations do not match the pinned assignment",
      );
  }
  const adjudication = run.adjudication;
  if ((adjudication ? hash(adjudication) : null) !== run.adjudicationDigest)
    throw new Error("Verification adjudication digest does not reconcile");
  if (adjudication) {
    parseProviderReview(adjudication);
    if (
      !readyProbe(probe) ||
      adjudication.contextDigest !== context.contextDigest ||
      adjudication.packetDigest !==
        byteHash(
          createAdjudicationPacket(context, {
            target,
            recipe,
            probe: probe!,
            counterclaims: refutation.verifier.candidates,
          }),
        ) ||
      adjudication.configDigest !== refutation.verifier.configDigest ||
      adjudication.runId === refutation.verifier.runId ||
      adjudication.attempts.some((item) =>
        refutation.verifier.attempts.some(
          (previous) => previous.id === item.id,
        ),
      )
    )
      throw new Error(
        "Verification adjudication assignment and independent sessions do not reconcile",
      );
  }
  const budget = refutation.verifier.aggregateBudget;
  if (
    run.budgetScope !==
      (budget ? "verification-run" : "per-provider-assignment") ||
    (budget && budget.priorAttempts.length !== 0) ||
    (adjudication &&
      (Boolean(budget) !== Boolean(adjudication.aggregateBudget) ||
        (budget &&
          (adjudication.aggregateBudget!.id !== budget.id ||
            !isDeepStrictEqual(
              adjudication.aggregateBudget!.priorAttempts,
              refutation.verifier.attempts,
            ) ||
            !isDeepStrictEqual(
              adjudication.limits,
              refutation.verifier.limits,
            ) ||
            !isDeepStrictEqual(
              adjudication.aggregateBudget!.operatorRates,
              budget.operatorRates,
            )))))
  )
    throw new Error("Verification shared provider budget does not reconcile");
  if (
    (refutation.verifier.freshness === "stale" ||
      probe?.freshness === "stale" ||
      adjudication?.freshness === "stale") &&
    run.freshness !== "stale"
  )
    throw new Error("Stale verification evidence cannot be current");
  const incomplete = incompleteReason(refutation, probe, adjudication);
  if (
    run.evidenceTier !== tier(probe, run.freshness) ||
    (run.status === "completed" &&
      (incomplete !== "completed" || run.freshness !== "current")) ||
    (run.status === "incomplete" &&
      (incomplete === "completed" ||
        run.freshness !== "current" ||
        run.stopReason !== incomplete)) ||
    (run.status === "stale" && run.freshness !== "stale") ||
    (run.status !== "incomplete" && run.stopReason !== run.status)
  )
    throw new Error(
      "Verification completion and evidence tier do not reconcile",
    );
  return run;
}
export function projectReviewVerification(
  input: unknown,
  detailed: boolean,
  allowReviewSource: boolean,
): Record<string, unknown> {
  const run = parseReviewVerification(input);
  if (detailed && allowReviewSource) return run;
  const {
    context,
    target,
    recipe,
    refutation,
    probe,
    adjudication,
    ...metadata
  } = run;
  void context;
  void target;
  void recipe;
  return reviewVerificationSummarySchema.parse({
    ...metadata,
    refutation: projectProviderRefutation(refutation, false, false),
    probe: probe ? projectReviewProbe(probe, false) : null,
    adjudication: adjudication
      ? projectProviderReview(adjudication, false, false)
      : null,
    sourceIncluded: false,
  });
}
