import { createHash } from "node:crypto";
import { z } from "zod";
import { parseReviewContext } from "./review.js";
import { VERSION } from "./types.js";

export const reviewFamilySchema = z.enum([
  "authorization-tenancy",
  "identifiers-allowlists",
  "types-numeric-semantics",
  "lifecycle-ordering",
  "assembly-wiring",
  "concurrency-resources",
  "atomic-artifacts",
  "dependencies-builds",
  "test-adequacy",
]);
export const hypothesisSelectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  families: z.array(reviewFamilySchema).min(1).max(9),
});
const text = z.string().min(1).max(1024);
const familySchema = z.strictObject({
  id: reviewFamilySchema,
  version: z.literal("1.0.0"),
  applicability: z.literal("requires-review"),
  trigger: text,
  invariant: text,
  questions: z.array(text).min(1).max(8),
  evidenceRequirements: z.array(text).min(1).max(8),
  limits: z.array(text).min(1).max(8),
});
const common = {
  version: "1.0.0" as const,
  applicability: "requires-review" as const,
  limits: [
    "A question is not a detected defect. Applicability, runtime reachability and authoritative requirements remain unverified.",
    "Read the assigned current source, relevant defaults, callers and the complete sibling set before prescribing a reachable fix.",
    "Missing context, unsupported semantics and unavailable probes must remain unresolved; agreement and green checks are not causal evidence.",
  ],
};
const catalogue = z
  .array(familySchema)
  .length(9)
  .parse([
    {
      ...common,
      id: "authorization-tenancy",
      trigger:
        "An edited decision accepts identity, role, ownership, tenant or capability input.",
      invariant:
        "Every reachable caller must enforce the authoritative privilege and ownership boundary before reading or changing protected state.",
      questions: [
        "Which public and framework-declared callers reach the decision, and can untrusted input choose a privileged role or a different tenant?",
        "Do parent declarations, bindings or middleware already supply a guard; what happens for missing, malformed and cross-owner input?",
      ],
      evidenceRequirements: [
        "Contemporaneous authorization contract and reachable caller/default evidence.",
        "Denied unprivileged/cross-owner input, a permitted control and the actual protected consequence.",
      ],
    },
    {
      ...common,
      id: "identifiers-allowlists",
      trigger:
        "An edited matcher selects identifiers, headers, origins, paths, permissions, routes or extensions.",
      invariant:
        "The admitted set must equal the authoritative policy after normalization, with complete identifier and separator boundaries.",
      questions: [
        "Enumerate the normalized strings admitted by this matcher; which unintended prefix, suffix or adjacent identifier is admitted?",
        "Does a proposed allowlist implement the intended set at every sibling call site, including parameterized identifiers?",
      ],
      evidenceRequirements: [
        "Exact normalization and policy definition at the assigned source address.",
        "An admitted unintended string and rejected sibling controls, including valid names and separators.",
      ],
    },
    {
      ...common,
      id: "types-numeric-semantics",
      trigger:
        "An edited conversion, fallback, contract check or arithmetic path selects an amount, type or status.",
      invariant:
        "Valid contract implementations and units retain their meaning, and absent or malformed values must not become observed values or privileged fallbacks.",
      questions: [
        "Does a concrete-class check exclude a valid interface implementation, or does conversion move a failure inside an error handler?",
        "Which values exercise zero, missing, fractional, signed, overflow and boundary behavior; do the fixtures actually require conversion?",
      ],
      evidenceRequirements: [
        "Declared interface/unit and the complete decision or error-handling path.",
        "Broken boundary input, repaired behavior and a valid non-base implementation or numeric near miss.",
      ],
    },
    {
      ...common,
      id: "lifecycle-ordering",
      trigger:
        "An edited hook, reused object, cleanup path or asynchronous operation changes state ordering.",
      invariant:
        "Required state must exist before it is consumed, and all reusable state and resources must be restored on both success and failure.",
      questions: [
        "Which hook runs first, what is cleared before it is read, and what guard is installed after its first consumer?",
        "Enumerate every reusable field and acquired resource; does an assertion failure bypass cleanup or leak state to the next operation?",
      ],
      evidenceRequirements: [
        "Observed ordered events and the complete reusable state/resource set.",
        "A second operation and an exception/cancellation control proving cleanup and isolation.",
      ],
    },
    {
      ...common,
      id: "assembly-wiring",
      trigger:
        "An edited bootstrap, provider, route, listener, schedule or binding changes application assembly.",
      invariant:
        "The assembled registrations, multiplicities and ordering must match the authoritative contract, including registrations supplied by packages and defaults.",
      questions: [
        "What does the actual runtime assembly hold before and after this change, rather than what repository route files declare?",
        "Are listeners or middleware duplicated, omitted or reordered, and do framework bindings introduce callers that text search cannot find?",
      ],
      evidenceRequirements: [
        "Supported native assembly capture and its completeness/identity accounting.",
        "Exact before/after registrations, a deliberate duplicate or ordering defect and a valid control.",
      ],
    },
    {
      ...common,
      id: "concurrency-resources",
      trigger:
        "An edited batch, retry, cache, connection, lock or repeated operation has a scale-dependent guard.",
      invariant:
        "Resource limits, ownership and guards must hold at the triggering scale and under the declared interleavings, including failure and cancellation.",
      questions: [
        "What arms the guard, and does the fixture cross that threshold rather than staying at one item or one attempt?",
        "Which interleaving, exhaustion or retry path changes the observable consequence, and what state survives failure?",
      ],
      evidenceRequirements: [
        "Guard predicate, trigger scale and supported concurrency/runtime profile.",
        "Armed failing schedule or scale, a comparative repaired/control result and cleanup evidence.",
      ],
    },
    {
      ...common,
      id: "atomic-artifacts",
      trigger:
        "An edited generator, installer or migration writes several related artifacts.",
      invariant:
        "Every target and edit must be validated before mutation, and distinct already-done and cannot-complete outcomes must stay distinguishable.",
      questions: [
        "Can a later target fail after earlier writes, leaving a half-applied state or a message that reports success?",
        "Does the dry run resolve every edit, and does failure preserve the original artifact set at every sibling writer?",
      ],
      evidenceRequirements: [
        "Complete target/write ordering and distinct return outcomes.",
        "A late-target failure with exact before/after artifacts, plus a valid already-done and successful control.",
      ],
    },
    {
      ...common,
      id: "dependencies-builds",
      trigger:
        "An edited package manager, lockfile, build step, copied file or published interface changes consumers.",
      invariant:
        "Declared dependency, build and consumer changes must match the produced artifact and preserve unrelated versions, integrity and intended cost bounds.",
      questions: [
        "Did a lockfile regeneration also upgrade dependencies; are copied dependencies pinned and their integrity and provenance actually checked?",
        "Which fresh consumer exercises the built artifact, and which apparently constant build step grows with files or resources?",
      ],
      evidenceRequirements: [
        "Resolved dependency/artifact identities and complete source/tool scope.",
        "Fresh consumer type/runtime behavior, a deliberate incompatible artifact and a valid unchanged-version or bounded-cost control.",
      ],
    },
    {
      ...common,
      id: "test-adequacy",
      trigger:
        "An edited test, assertion, stub, extraction, suppression or coverage claim defends behavior.",
      invariant:
        "The asserted behavior must be correct and production-reachable, and removing each claimed guard or preserved behavior must fail the intended assertion.",
      questions: [
        "Does the test name still describe its assertion, and can a privileged expected outcome itself specify a bug?",
        "Which exact test fails without each moved behavior; are mocks rendering impossible application state or fixtures leaving runtime guards unarmed?",
        "Does suppression accounting reconcile narrow live entries and stale entries, including commented and near-miss spellings?",
      ],
      evidenceRequirements: [
        "Production contract, real test-double behavior and exact assertion/guard identity.",
        "Intended guard-removal failure, comparative valid control and complete suppression/sibling accounting.",
      ],
    },
  ]);
const catalogueDigest = createHash("sha256")
  .update(JSON.stringify(catalogue))
  .digest("hex");
const count = z.number().int().nonnegative().max(64);
const metadata = {
  schemaVersion: z.literal(1),
  format: z.literal("review-hypothesis-plan"),
  engineVersion: z.string(),
  channel: z.literal("advisory"),
  provenance: z.literal("builtin-hypothesis-catalogue"),
  automatedCoverage: z.literal(false),
  claimsVerified: z.literal(false),
  modelInvoked: z.literal(false),
  freshness: z.literal("not-checked"),
  sourceIncluded: z.literal(false),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  catalogueDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.strictObject({
    selectedPaths: count.min(1).max(32),
    capturedViews: count.min(1),
    syntaxCollectedViews: count,
    syntaxPartialViews: count,
    repositoryComplete: z.literal(false),
    runtimeReachability: z.literal("unknown"),
  }),
};
export const hypothesisPlanSchema = z.strictObject({
  ...metadata,
  families: z.array(familySchema).min(1).max(9),
});
export const hypothesisSummarySchema = z.strictObject({
  ...metadata,
  families: z.array(reviewFamilySchema).min(1).max(9),
});
export type HypothesisPlan = z.infer<typeof hypothesisPlanSchema>;

export function createHypothesisPlan(
  contextInput: unknown,
  input: unknown = { schemaVersion: 1, families: reviewFamilySchema.options },
): HypothesisPlan {
  const context = parseReviewContext(contextInput);
  if (
    context.schemaVersion !== 4 &&
    context.schemaVersion !== 5 &&
    context.schemaVersion !== 6 &&
    context.schemaVersion !== 7 &&
    context.schemaVersion !== 8 &&
    context.schemaVersion !== 9 &&
    context.schemaVersion !== 10 &&
    context.schemaVersion !== 11 &&
    context.schemaVersion !== 12 &&
    context.schemaVersion !== 13 &&
    context.schemaVersion !== 14 &&
    context.schemaVersion !== 15 &&
    context.schemaVersion !== 16 &&
    context.schemaVersion !== 17
  )
    throw new Error(
      "Hypothesis planning requires review context version 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 or 17",
    );
  const selection = hypothesisSelectionSchema.parse(input);
  if (new Set(selection.families).size !== selection.families.length)
    throw new Error("Hypothesis families must be unique");
  return hypothesisPlanSchema.parse({
    schemaVersion: 1,
    format: "review-hypothesis-plan",
    engineVersion: VERSION,
    channel: "advisory",
    provenance: "builtin-hypothesis-catalogue",
    automatedCoverage: false,
    claimsVerified: false,
    modelInvoked: false,
    freshness: "not-checked",
    sourceIncluded: false,
    contextDigest: context.contextDigest,
    catalogueDigest,
    scope: {
      selectedPaths:
        context.selection.files.length + context.selection.supportFiles.length,
      capturedViews: context.analysis.files.length,
      syntaxCollectedViews: context.analysis.files.filter(
        (file) => file.state === "collected",
      ).length,
      syntaxPartialViews: context.analysis.files.filter(
        (file) => file.state !== "collected",
      ).length,
      repositoryComplete: false,
      runtimeReachability: "unknown",
    },
    families: catalogue.filter((family) =>
      selection.families.includes(family.id),
    ),
  });
}
export function projectHypothesisPlan(
  input: HypothesisPlan,
  detailed: boolean,
): Record<string, unknown> {
  const plan = hypothesisPlanSchema.parse(input);
  if (
    plan.scope.syntaxCollectedViews + plan.scope.syntaxPartialViews !==
      plan.scope.capturedViews ||
    plan.scope.capturedViews < plan.scope.selectedPaths ||
    plan.scope.capturedViews > plan.scope.selectedPaths * 2
  )
    throw new Error("Hypothesis scope counts do not reconcile");
  if (
    plan.catalogueDigest !== catalogueDigest ||
    plan.families.some(
      (family) =>
        JSON.stringify(family) !==
        JSON.stringify(catalogue.find((expected) => expected.id === family.id)),
    ) ||
    new Set(plan.families.map((family) => family.id)).size !==
      plan.families.length
  )
    throw new Error("Hypothesis plan does not match the current catalogue");
  if (detailed) return plan;
  return hypothesisSummarySchema.parse({
    ...plan,
    families: plan.families.map((family) => family.id),
  });
}
