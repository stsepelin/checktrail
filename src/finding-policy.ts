import { createHash } from "node:crypto";
import { z } from "zod";
import {
  findingBaselineSchema,
  findingBaselineEntrySchema,
  findingKeySchema,
  type FindingBaseline,
  type FindingComparison,
} from "./finding-policy-schema.js";
import { validatedReport } from "./report-validation.js";
import { VERSION } from "./types.js";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function projectFindingComparison(
  result: FindingComparison,
  detailed: boolean,
) {
  if (detailed) return result;
  return {
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    provenance: result.provenance,
    outcome: result.outcome,
    validationOutcome: result.validationOutcome,
    reason: result.reason,
    sourceVerified: result.sourceVerified,
    baselineFingerprint: result.baselineFingerprint,
    counts: result.counts,
    limitExceeded: result.limitExceeded,
    unaccountedFailures: result.unaccountedFailures,
  };
}
const keyId = (key: z.infer<typeof findingKeySchema>) =>
  digest([
    key.checkId,
    key.project,
    key.ruleId,
    key.file,
    key.line,
    key.level,
    key.messageHash,
  ]);
function baseline(input: unknown): FindingBaseline {
  const result = findingBaselineSchema.parse(input);
  const ids = new Set<string>();
  for (const entry of result.entries) {
    if (entry.id !== keyId(entry) || ids.has(entry.id))
      throw new Error("Invalid or duplicate baseline finding identity");
    ids.add(entry.id);
  }
  return result;
}
function findings(report: ReturnType<typeof validatedReport>) {
  const result = new Map<
    string,
    { key: z.infer<typeof findingKeySchema> | undefined; count: number }
  >();
  for (const check of report.checks)
    for (const finding of check.findings ?? []) {
      const parsed = findingKeySchema.safeParse({
        checkId: check.id,
        project: check.project,
        ruleId: finding.ruleId,
        file: finding.file,
        line: finding.line,
        level: finding.level,
        messageHash: digest(finding.message),
      });
      const id = parsed.success
        ? keyId(parsed.data)
        : digest([check.id, check.project, finding]);
      const previous = result.get(id);
      result.set(id, {
        key: parsed.success ? parsed.data : undefined,
        count: (previous?.count ?? 0) + 1,
      });
    }
  return result;
}
export function createFindingBaseline(
  input: unknown,
  options: {
    owner: string;
    reason: string;
    kind?: "baseline" | "exception";
    expiresAt?: string;
  },
): FindingBaseline {
  const report = validatedReport(input);
  const metadata = findingBaselineEntrySchema
    .pick({ owner: true, reason: true, kind: true, expiresAt: true })
    .parse({ ...options, kind: options.kind ?? "baseline" });
  if (
    report.outcome === "incomplete" ||
    report.sourceFingerprint !== report.finalSourceFingerprint ||
    report.sourceChanged ||
    report.sourceError ||
    report.checks.some(
      (check) =>
        !["passed", "failed"].includes(check.status) ||
        check.tools?.some((tool) => tool.status !== "identified"),
    )
  )
    throw new Error(
      "Baseline creation requires current and conclusive validation evidence",
    );
  if (
    report.checks.some(
      (check) =>
        check.status === "failed" &&
        (!check.findingsComplete || !check.findings?.length),
    )
  )
    throw new Error(
      "Baseline creation cannot account for every native failure",
    );
  const entries = [...findings(report)].map(([id, item]) => {
    if (!item.key)
      throw new Error(
        "Baselines require an exact source file, line and native finding identity",
      );
    return findingBaselineEntrySchema.parse({
      ...item.key,
      id,
      occurrences: item.count,
      ...metadata,
    });
  });
  return baseline({
    schemaVersion: 1,
    createdFrom: {
      runId: report.runId,
      sourceFingerprint: report.sourceFingerprint,
      policyFingerprint: report.policyFingerprint,
    },
    limits: {
      maxEntries: entries.length,
      maxExceptions: entries.filter((entry) => entry.kind === "exception")
        .length,
    },
    entries,
  });
}
export function compareFindings(
  input: unknown,
  baselineInput: unknown,
  options: { now?: string; previousBaseline?: unknown } = {},
): FindingComparison {
  const report = validatedReport(input);
  const policy = baseline(baselineInput);
  const previous =
    options.previousBaseline === undefined
      ? undefined
      : baseline(options.previousBaseline);
  const now =
    options.now === undefined
      ? Date.now()
      : Date.parse(z.iso.datetime().parse(options.now));
  const sourceVerified =
    !report.sourceChanged &&
    !report.sourceError &&
    report.finalSourceFingerprint === report.sourceFingerprint;
  const current = findings(report);
  const counts = {
    current: [...current.values()].reduce((sum, item) => sum + item.count, 0),
    new: 0,
    matched: 0,
    stale: 0,
    expired: 0,
    changed: 0,
    unverified: 0,
    expanded: 0,
    modified: 0,
  };
  const entries: FindingComparison["entries"] = [];
  for (const entry of policy.entries) {
    const found = current.get(entry.id);
    const check = report.checks.find(
      (check) => check.id === entry.checkId && check.project === entry.project,
    );
    const accounted =
      check &&
      (check.status === "passed" ||
        (check.status === "failed" && check.findingsComplete === true));
    let status: FindingComparison["entries"][number]["status"];
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= now)
      status = "expired";
    else if (!sourceVerified || !accounted) status = "unverified";
    else if (!found) status = "stale";
    else if (found.count !== entry.occurrences) status = "changed";
    else status = "matched";
    counts[status]++;
    entries.push({ id: entry.id, status, occurrences: found?.count ?? 0 });
  }
  const ids = new Set(policy.entries.map((entry) => entry.id));
  const newFindingIds = [...current.keys()].filter((id) => !ids.has(id));
  counts.new = newFindingIds.reduce(
    (sum, id) => sum + current.get(id)!.count,
    0,
  );
  if (previous) {
    const old = new Map(previous.entries.map((entry) => [entry.id, entry]));
    for (const entry of policy.entries) {
      const existing = old.get(entry.id);
      if (!existing) counts.expanded++;
      else if (digest(existing) !== digest(entry)) counts.modified++;
    }
  }
  const limitExceeded =
    policy.entries.length > policy.limits.maxEntries ||
    policy.entries.filter((entry) => entry.kind === "exception").length >
      policy.limits.maxExceptions ||
    Boolean(
      previous &&
      (policy.limits.maxEntries > previous.limits.maxEntries ||
        policy.limits.maxExceptions > previous.limits.maxExceptions),
    );
  const unaccountedFailures = report.checks.filter(
    (check) =>
      check.status === "failed" &&
      (!check.findingsComplete || !check.findings?.length),
  ).length;
  const failed =
    counts.new ||
    counts.stale ||
    counts.expired ||
    counts.changed ||
    counts.expanded ||
    counts.modified ||
    limitExceeded ||
    unaccountedFailures;
  const incomplete =
    !sourceVerified ||
    counts.unverified ||
    report.outcome === "incomplete" ||
    report.checks.some(
      (check) =>
        !["passed", "failed"].includes(check.status) ||
        check.tools?.some((tool) => tool.status !== "identified"),
    );
  const outcome = failed ? "failed" : incomplete ? "incomplete" : "passed";
  return {
    schemaVersion: 1,
    engineVersion: VERSION,
    provenance: "finding-comparison",
    outcome,
    validationOutcome: report.outcome,
    reason:
      outcome === "passed"
        ? "Finding policy matches the supplied report; the native validation outcome is retained separately."
        : outcome === "failed"
          ? "Finding policy has new, stale, expired, changed or expanded entries, exceeded limits, or unaccounted native failures."
          : "Finding policy cannot be reconciled against complete current-source evidence.",
    sourceVerified,
    baselineFingerprint: digest(policy),
    counts,
    limitExceeded,
    unaccountedFailures,
    entries,
    newFindingIds,
  };
}
