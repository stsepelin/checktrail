import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { VERSION } from "./types.js";
import {
  inspectReviewProvenance,
  replayReviewProvenance,
} from "./review-provenance.js";
import {
  parseReviewContext,
  receiveReview,
  type ReviewReceipt,
} from "./review.js";
import {
  observeFindingParameters,
  type FindingParameterObservation,
} from "./review-finding-parameters.js";
import {
  reviewFindingsInputSchema,
  reviewFindingsReportSchema,
  reviewFindingsSummarySchema,
  type ReviewFindingsInput,
  type ReviewFindingsReport,
  type ReviewFindingGap,
} from "./review-findings-schema.js";
export {
  reviewFindingsInputSchema,
  reviewFindingsReportSchema,
  reviewFindingsSummarySchema,
} from "./review-findings-schema.js";
export type {
  ReviewFindingsInput,
  ReviewFindingsReport,
} from "./review-findings-schema.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function require(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
function parameterIds(input: ReviewFindingsInput) {
  return input.decisions.flatMap(
    (d) => d.adjudication.judgment?.repair?.functionId ?? [],
  );
}
type Consequence = NonNullable<
  NonNullable<
    ReviewFindingsInput["decisions"][number]["adjudication"]["judgment"]
  >["consequence"]
>;
function consequenceSeverity(
  impact: Consequence | null,
): "high" | "moderate" | "low" | "unassigned" {
  if (
    !impact ||
    [impact.category, impact.extent, impact.access, impact.recovery].includes(
      "unknown",
    )
  )
    return "unassigned";
  if (impact.category === "maintainability") return "low";
  if (impact.category === "security-boundary" && impact.access !== "privileged")
    return "high";
  if (
    (impact.category === "data-loss" || impact.category === "wrong-result") &&
    impact.recovery === "irreversible"
  )
    return "high";
  if (impact.extent === "systemwide" && impact.category !== "wrong-result")
    return "high";
  return "moderate";
}
function derive(
  input: ReviewFindingsInput,
  receipt: ReviewReceipt,
  parameters: Map<string, FindingParameterObservation>,
) {
  const provenance = replayReviewProvenance(input.provenance, receipt);
  const context = parseReviewContext(input.provenance.context);
  const candidates = new Map(input.provenance.candidates.map((c) => [c.id, c]));
  const decisions = new Map(input.decisions.map((d) => [d.candidateId, d]));
  require(decisions.size === input.decisions.length &&
    [...decisions.keys()].every((id) =>
      candidates.has(id),
    ), "Unique selected decision bindings required");
  const memberships = input.commonDefects.flatMap((g) => g.candidateIds);
  require(new Set(input.commonDefects.map((g) => g.id)).size ===
    input.commonDefects.length &&
    new Set(memberships).size === memberships.length &&
    memberships.every((id) =>
      candidates.has(id),
    ), "Unique selected common-defect memberships required");
  for (const d of input.decisions) {
    for (const s of [d.refutation, d.adjudication])
      require(s.state !== "completed" ||
        (s.sessionId !== null &&
          s.rationale !==
            null), "Completed stages require declared identity and rationale");
    require(d.adjudication.state !== "completed" ||
      d.adjudication.judgment !==
        null, "Completed adjudication requires a judgment");
    const required = d.adjudication.judgment?.repair?.requiredParameters ?? [];
    require(new Set(required).size ===
      required.length, "Unique repair parameter names required");
  }
  // Count all roles before deriving rows: reuse degrades every affected candidate.
  const sessions = new Map<string, number>([[input.reviewerSessionId, 1]]);
  for (const d of input.decisions)
    for (const s of [d.refutation, d.adjudication])
      if (s.sessionId !== null)
        sessions.set(s.sessionId, (sessions.get(s.sessionId) ?? 0) + 1);
  const functions =
    "analysis" in context
      ? context.analysis.functions.filter((f) => f.revision === "current")
      : [];
  const findings = provenance.candidateEvidence.map((e) => {
    const c = candidates.get(e.id)!;
    const d = decisions.get(e.id);
    const gaps: ReviewFindingGap[] = [];
    let rootFunctionId: string | null = null;
    let declaredSeverity: "high" | "moderate" | "low" | "unassigned" =
      "unassigned";
    let parameterState: "observed" | "unavailable" | "not-requested" =
      "not-requested";
    let available: string[] = [],
      missing: string[] = [];
    if (receipt.freshness !== "current") gaps.push("stale-source");
    if (!e.sourceAddressesVerified) gaps.push("unmatched-source");
    if (!d) gaps.push("missing-decision");
    else {
      const run = input.provenance.native.find(
        (n) => n.candidateId === c.id,
      )?.run;
      if (
        d.contextDigest !== context.contextDigest ||
        d.candidateDigest !== e.candidateDigest ||
        d.nativeRunDigest !== (run ? hash(run) : null) ||
        !isDeepStrictEqual(d.nativeCaseIds, run?.trials.map((t) => t.id) ?? [])
      )
        gaps.push("binding-differs");
      if ([d.refutation, d.adjudication].some((s) => s.state !== "completed"))
        gaps.push("incomplete-stages");
      if (
        sessions.get(input.reviewerSessionId)! > 1 ||
        [d.refutation, d.adjudication].some(
          (s) => s.sessionId !== null && sessions.get(s.sessionId)! > 1,
        )
      )
        gaps.push("reused-session");
      if (
        e.tier !== "native-receipt-reconciled" ||
        run?.freshness !== "current"
      )
        gaps.push("native-unavailable");
      // Receipts have a digest/range, not a physical filename. Same-byte files are ambiguous.
      const addresses = run
        ? functions.filter(
            (f) =>
              f.start === run.functionRange.start &&
              f.end === run.functionRange.end &&
              context.files.some(
                (file) =>
                  file.path === f.file && file.sha256 === run.sourceDigest,
              ),
          )
        : [];
      if (addresses.length !== 1) gaps.push("ambiguous-native-address");
      else rootFunctionId = addresses[0]!.id;
      const j = d.adjudication.judgment;
      if (!j || j.disposition === "unresolved")
        gaps.push("unresolved-judgment");
      if (j) {
        const citation = c.citations[j.citationIndex];
        const root = addresses[0];
        if (
          !root ||
          addresses.length !== 1 ||
          j.functionId !== root.id ||
          !citation ||
          citation.revision !== "current" ||
          citation.file !== root.file ||
          citation.startLine > root.endLine ||
          citation.endLine < root.startLine
        )
          gaps.push("source-address-differs");
        if (!j.mechanism || !j.reachableCallers || !j.defaultsChecked)
          gaps.push("incomplete-reasoning");
        if (j.disposition === "supported") {
          if (run?.behavior !== "violated")
            gaps.push("native-predicate-not-violated");
          declaredSeverity = consequenceSeverity(j.consequence);
          if (declaredSeverity === "unassigned")
            gaps.push("consequence-unknown");
          if (!j.repair) gaps.push("repair-missing");
        }
        if (j.repair) {
          const repair = j.repair;
          const fn = functions.find((f) => f.id === repair.functionId);
          const cite = c.citations[repair.citationIndex];
          const observed = parameters.get(repair.functionId);
          if (
            !fn ||
            !cite ||
            cite.revision !== "current" ||
            cite.file !== fn.file ||
            cite.startLine > fn.endLine ||
            cite.endLine < fn.startLine ||
            !context.files.some(
              (file) =>
                file.path === fn.file && file.sha256 === cite.sourceDigest,
            )
          )
            gaps.push("repair-address-differs");
          parameterState = observed?.state ?? "unavailable";
          available = observed?.names ?? [];
          missing = repair.requiredParameters.filter(
            (name) => !available.includes(name),
          );
          if (parameterState !== "observed")
            gaps.push("repair-parameters-unavailable");
          else if (missing.length) gaps.push("repair-parameter-missing");
          if (repair.scope === "unknown") gaps.push("repair-scope-unknown");
        }
      }
    }
    const disposition = d?.adjudication.judgment?.disposition;
    const state =
      gaps.length === 0 && disposition === "supported"
        ? ("declared-supported" as const)
        : gaps.length === 0 && disposition === "refuted"
          ? ("declared-refuted" as const)
          : ("unresolved" as const);
    return {
      candidateId: c.id,
      candidateDigest: e.candidateDigest,
      state,
      gaps: [...new Set(gaps)],
      rootFunctionId,
      declaredSeverity,
      repairParameters: { state: parameterState, available, missing },
    };
  });
  const byId = new Map(findings.map((f) => [f.candidateId, f]));
  const groups = input.commonDefects.map((g) => {
    const members = g.candidateIds.map((id) => byId.get(id)!);
    const reason = members.some((f) => f.state !== "declared-supported")
      ? ("member-unresolved" as const)
      : members.some((f) => f.rootFunctionId !== g.rootFunctionId)
        ? ("root-function-differs" as const)
        : ("source-addresses-reconciled" as const);
    return {
      id: g.id,
      candidateIds: g.candidateIds,
      state:
        reason === "source-addresses-reconciled"
          ? ("declared-common-defect" as const)
          : ("unresolved" as const),
      reason,
    };
  });
  const counts = {
    selected: findings.length,
    "declared-supported": 0,
    "declared-refuted": 0,
    unresolved: 0,
  };
  for (const f of findings) counts[f.state]++;
  const mapped = new Set(
    groups
      .filter((g) => g.state === "declared-common-defect")
      .flatMap((g) => g.candidateIds),
  );
  const commonDefects = {
    declared: groups.length,
    reconciled: groups.filter((g) => g.state === "declared-common-defect")
      .length,
    unresolved: groups.filter((g) => g.state === "unresolved").length,
    mappedSupported: mapped.size,
    unmappedSupported: counts["declared-supported"] - mapped.size,
  };
  require(counts.selected ===
    counts["declared-supported"] +
      counts["declared-refuted"] +
      counts.unresolved &&
    commonDefects.declared ===
      commonDefects.reconciled + commonDefects.unresolved &&
    commonDefects.mappedSupported + commonDefects.unmappedSupported ===
      counts["declared-supported"], "Finding categories do not close");
  return {
    schemaVersion: 1 as const,
    format: "review-findings-report" as const,
    engineVersion: VERSION,
    channel: "advisory" as const,
    inputDigest: hash(input),
    contextDigest: context.contextDigest,
    freshness: receipt.freshness,
    status:
      receipt.freshness === "stale"
        ? ("stale" as const)
        : provenance.status !== "completed" ||
            !counts.selected ||
            counts.unresolved ||
            commonDefects.unresolved ||
            commonDefects.unmappedSupported
          ? ("incomplete" as const)
          : ("completed" as const),
    judgmentProvenance: "host-declared-unverified" as const,
    nativeReceiptProvenance: "imported-unattested" as const,
    severityPolicy: "declared-consequence-matrix-v1" as const,
    severityVerified: false as const,
    claimsVerified: false as const,
    independenceVerified: false as const,
    commonCauseVerified: false as const,
    repairCorrectnessVerified: false as const,
    nativeExecution: false as const,
    deterministicOutcomeChanged: false as const,
    qualityGate: "not-assessed" as const,
    candidates: counts,
    commonDefects,
    findings,
    groups,
  };
}
function bounded(report: ReviewFindingsReport) {
  require(Buffer.byteLength(JSON.stringify(report)) <=
    4194304, "Finding report exceeds output limit");
  return report;
}
export async function inspectReviewFindings(
  root: string,
  text: string,
  options: { signal?: AbortSignal; wallMs?: number } = {},
): Promise<ReviewFindingsReport> {
  require(typeof text === "string" &&
    Buffer.byteLength(text) <=
      1048576, "Bounded serialized findings JSON required");
  const wallMs = z
    .number()
    .int()
    .min(1)
    .max(120000)
    .parse(options.wallMs ?? 30000);
  const deadline = performance.now() + wallMs;
  const guard = () => {
    require(!options.signal?.aborted, "Findings inspection cancelled");
    require(performance.now() < deadline, "Findings inspection timed out");
  };
  guard();
  const input = reviewFindingsInputSchema.parse(JSON.parse(text));
  guard();
  await inspectReviewProvenance(root, JSON.stringify(input.provenance), {
    ...(options.signal ? { signal: options.signal } : {}),
    wallMs,
  });
  guard();
  const parameters = await observeFindingParameters(
    parseReviewContext(input.provenance.context),
    parameterIds(input),
    guard,
  );
  guard();
  // All asynchronous parsing is finished. Recheck current sources at the final boundary.
  const receipt = await receiveReview(
    root,
    input.provenance.context,
    input.provenance.assessment,
  );
  guard();
  const report = bounded(
    reviewFindingsReportSchema.parse({
      ...derive(input, receipt, parameters),
      input,
      receipt,
    }),
  );
  guard();
  return report;
}
export async function projectReviewFindings(
  value: unknown,
  allowSource = false,
) {
  const report = bounded(reviewFindingsReportSchema.parse(value));
  const { input, receipt, findings, groups, ...summary } = report;
  const parameters = await observeFindingParameters(
    parseReviewContext(input.provenance.context),
    parameterIds(input),
  );
  const {
    findings: expectedFindings,
    groups: expectedGroups,
    ...expected
  } = derive(input, receipt, parameters);
  require(isDeepStrictEqual(summary, expected) &&
    isDeepStrictEqual(findings, expectedFindings) &&
    isDeepStrictEqual(
      groups,
      expectedGroups,
    ), "Finding derived evidence does not reconcile");
  if (allowSource) return report;
  return reviewFindingsSummarySchema.parse({
    ...summary,
    sourceIncluded: false,
  });
}
