import { createHash } from "node:crypto";
import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = (kind: string) =>
  z.string().regex(new RegExp("^" + kind + "-[a-f0-9]{32}$"));
const reason = z.enum([
  "missing-notice",
  "missing-license",
  "unknown-distribution",
  "private-service",
  "undistributable-input",
  "previous-exposure",
  "unknown-exposure",
  "out-of-scope",
]);
export const reviewCohortDeclarationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("evaluation-cohort-declaration-v1"),
  referenceId: id("reference"),
  priorWorkflowId: id("workflow"),
  grouping: z.strictObject({
    holdoutRepositories: z.boolean(),
    holdoutFamilies: z.boolean(),
  }),
  cases: z
    .array(
      z.strictObject({
        id: id("case"),
        repositoryId: id("repository"),
        familyId: id("family"),
        lineageId: id("lineage"),
        contentSha256: hash,
        split: z.enum(["development", "reserved", "retired"]),
        exposure: z.enum(["uninspected", "inspected", "unknown"]),
        sourceArchiveSha256: hash,
        noticeSha256: hash.nullable(),
        license: z
          .string()
          .min(1)
          .max(128)
          .refine((value) => value.trim() === value && value.trim().length > 0)
          .nullable(),
        requiresPrivateService: z.boolean(),
        distribution: z.enum(["permitted", "restricted", "unknown"]),
        inScope: z.boolean(),
        disposition: z.discriminatedUnion("status", [
          z.strictObject({ status: z.literal("selected") }),
          z.strictObject({
            status: z.literal("excluded"),
            reasons: z
              .array(reason)
              .min(1)
              .max(8)
              .refine((a) => new Set(a).size === a.length),
          }),
        ]),
      }),
    )
    .min(1)
    .max(256),
});
export type ReviewCohortDeclaration = z.infer<
  typeof reviewCohortDeclarationSchema
>;
export interface ReviewCohortDeclarationReport {
  schemaVersion: 1;
  profile: "evaluation-cohort-declaration-v1";
  declarationSha256: string;
  declarationComplete: boolean;
  counts: {
    total: number;
    selected: number;
    excluded: number;
    development: number;
    reserved: number;
    retired: number;
    components: number;
    issues: number;
  };
  issues: {
    kind:
      | "split-conflict"
      | "exposure"
      | "license-metadata"
      | "eligibility"
      | "disposition"
      | "empty-selection";
    caseIds: string[];
  }[];
  scope: string;
  sourceContentInspected: false;
  labelsInspected: false;
  licenseGrantVerified: false;
  sessionIndependenceVerified: false;
  acceptanceClaim: false;
  gateAClosed: false;
  inferenceExecuted: false;
  fieldEvaluationExecuted: false;
}
/** Inspect declarations only. This neither acquires cases nor attests imported claims. */
export function inspectReviewCohortDeclaration(
  input: unknown,
  expectedDeclarationSha256?: string,
): ReviewCohortDeclarationReport {
  if (
    input &&
    typeof input === "object" &&
    "cases" in input &&
    Array.isArray(input.cases) &&
    input.cases.length > 256
  )
    throw new Error("Cohort declaration exceeds case bound");
  const declaration = reviewCohortDeclarationSchema.parse(input);
  const rows = declaration.cases;
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new Error("Duplicate cohort case identity");
  const declarationSha256 = createHash("sha256")
    .update(JSON.stringify(declaration))
    .digest("hex");
  if (
    expectedDeclarationSha256 !== undefined &&
    hash.parse(expectedDeclarationSha256) !== declarationSha256
  )
    throw new Error("Cohort declaration identity changed");
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const keys = new Map<string, number>();
  for (const [i, row] of rows.entries()) {
    const bindings = [
      "lineage:" + row.lineageId,
      "content:" + row.contentSha256,
    ];
    if (declaration.grouping.holdoutRepositories)
      bindings.push("repository:" + row.repositoryId);
    if (declaration.grouping.holdoutFamilies)
      bindings.push("family:" + row.familyId);
    for (const key of bindings) {
      const previous = keys.get(key);
      if (previous === undefined) keys.set(key, i);
      else parent[find(i)] = find(previous);
    }
  }
  const groups = new Map<number, typeof rows>();
  for (const [i, row] of rows.entries()) {
    const root = find(i),
      group = groups.get(root) ?? [];
    group.push(row);
    groups.set(root, group);
  }
  const issues: ReviewCohortDeclarationReport["issues"] = [];
  if (!rows.some((row) => row.disposition.status === "selected"))
    issues.push({ kind: "empty-selection", caseIds: [] });

  for (const group of groups.values()) {
    // Excluded variants remain in the grouping and total denominator.
    if (new Set(group.map((r) => r.split)).size > 1)
      issues.push({
        kind: "split-conflict",
        caseIds: group.map((r) => r.id).sort(),
      });
  }
  for (const row of rows) {
    const missingLicense =
      row.license === null ||
      ["NONE", "NOASSERTION", "UNLICENSED"].includes(row.license);
    if (
      row.disposition.status === "selected" &&
      (row.requiresPrivateService ||
        row.distribution !== "permitted" ||
        !row.inScope ||
        row.split === "retired")
    )
      issues.push({ kind: "eligibility", caseIds: [row.id] });
    if (row.disposition.status === "excluded") {
      const observedReasons = {
        "missing-notice": row.noticeSha256 === null,
        "missing-license": missingLicense,
        "private-service": row.requiresPrivateService,
        "undistributable-input": row.distribution === "restricted",
        "unknown-distribution": row.distribution === "unknown",
        "previous-exposure": row.exposure === "inspected",
        "unknown-exposure": row.exposure === "unknown",
        "out-of-scope": !row.inScope,
      };
      if (row.disposition.reasons.some((reason) => !observedReasons[reason]))
        issues.push({ kind: "disposition", caseIds: [row.id] });
    }
    if (row.split === "reserved" && row.exposure !== "uninspected")
      issues.push({ kind: "exposure", caseIds: [row.id] });
    if (
      row.disposition.status === "selected" &&
      (missingLicense || !row.noticeSha256)
    )
      issues.push({ kind: "license-metadata", caseIds: [row.id] });
    if (
      row.disposition.status === "selected" &&
      row.exposure === "unknown" &&
      row.split !== "reserved"
    )
      issues.push({ kind: "exposure", caseIds: [row.id] });
  }
  return {
    schemaVersion: 1,
    profile: declaration.profile,
    declarationSha256,
    declarationComplete: issues.length === 0,
    counts: {
      total: rows.length,
      selected: rows.filter((r) => r.disposition.status === "selected").length,
      excluded: rows.filter((r) => r.disposition.status === "excluded").length,
      development: rows.filter((r) => r.split === "development").length,
      reserved: rows.filter((r) => r.split === "reserved").length,
      retired: rows.filter((r) => r.split === "retired").length,
      components: groups.size,
      issues: issues.length,
    },
    issues,
    scope:
      "Declared identities, dispositions and transitive lineage/content/repository/family grouping only; source, notices, labels, exposure history, host isolation and freeze chronology are not independently verified.",
    sourceContentInspected: false,
    labelsInspected: false,
    licenseGrantVerified: false,
    sessionIndependenceVerified: false,
    acceptanceClaim: false,
    gateAClosed: false,
    inferenceExecuted: false,
    fieldEvaluationExecuted: false,
  };
}
export function projectReviewCohortDeclaration(
  report: ReviewCohortDeclarationReport,
) {
  const { issues, ...summary } = report;
  return {
    ...summary,
    issues: issues.map((issue) => ({
      kind: issue.kind,
      caseCount: issue.caseIds.length,
    })),
  };
}
