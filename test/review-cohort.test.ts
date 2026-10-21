import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectReviewCohortDeclaration,
  projectReviewCohortDeclaration,
  reviewCohortDeclarationSchema,
} from "../src/review-cohort.js";
import * as library from "../src/index.js";
import type {
  ReviewCohortDeclaration,
  ReviewCohortDeclarationReport,
} from "../src/index.js";
const hex = (n: number) => n.toString(16).padStart(32, "0");
const sha = (n: number) => n.toString(16).padStart(64, "0");
function declaration(): ReviewCohortDeclaration {
  return {
    schemaVersion: 1,
    profile: "evaluation-cohort-declaration-v1",
    referenceId: "reference-" + hex(1),
    priorWorkflowId: "workflow-" + hex(2),
    grouping: { holdoutRepositories: false, holdoutFamilies: false },
    cases: [1, 2, 3].map((n) => ({
      id: "case-" + hex(n),
      repositoryId: "repository-" + hex(n),
      familyId: "family-" + hex(n),
      lineageId: "lineage-" + hex(n),
      contentSha256: sha(n),
      sourceArchiveSha256: sha(n + 10),
      noticeSha256: sha(n + 20),
      license: "MIT",
      requiresPrivateService: false,
      distribution: "permitted",
      inScope: true,
      split: n === 3 ? "reserved" : "development",
      exposure: "uninspected",
      disposition: { status: "selected" },
    })),
  };
}
test("cohort declarations detect a transitive contamination chain without dropping an excluded variant", () => {
  const input = declaration();
  input.cases[0]!.contentSha256 = input.cases[1]!.contentSha256;
  input.cases[1]!.lineageId = input.cases[2]!.lineageId;
  input.cases[1]!.disposition = {
    status: "excluded",
    reasons: ["out-of-scope"],
  };
  input.cases[1]!.inScope = false;
  const result = inspectReviewCohortDeclaration(input);
  assert.equal(result.declarationComplete, false);
  assert.deepEqual(result.issues, [
    { kind: "split-conflict", caseIds: input.cases.map((r) => r.id) },
  ]);
  assert.deepEqual(result.counts, {
    total: 3,
    selected: 2,
    excluded: 1,
    development: 2,
    reserved: 1,
    retired: 0,
    components: 1,
    issues: 1,
  });
});
test("cohort declaration repair preserves the common denominator and imported-claim limits", () => {
  const input = declaration();
  input.cases[0]!.contentSha256 = input.cases[1]!.contentSha256;
  input.cases[1]!.lineageId = input.cases[2]!.lineageId;
  input.cases[2]!.split = "development";
  const result = inspectReviewCohortDeclaration(input);
  assert.equal(result.declarationComplete, true);
  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.components, 1);
  assert.equal(result.sourceContentInspected, false);
  assert.equal(result.labelsInspected, false);
  assert.equal(result.licenseGrantVerified, false);
  assert.equal(result.sessionIndependenceVerified, false);
  assert.equal(result.acceptanceClaim, false);
  assert.equal(result.inferenceExecuted, false);
  assert.equal(result.gateAClosed, false);
});
test("cohort declaration uses exact namespaced identities and optional repository and family holdouts", () => {
  const input = declaration();
  input.cases[2]!.repositoryId = input.cases[0]!.repositoryId;
  assert.equal(inspectReviewCohortDeclaration(input).declarationComplete, true);
  input.grouping.holdoutRepositories = true;
  assert.equal(
    inspectReviewCohortDeclaration(input).declarationComplete,
    false,
  );
  input.grouping.holdoutRepositories = false;
  input.grouping.holdoutFamilies = true;
  input.cases[2]!.familyId = input.cases[1]!.familyId;
  assert.equal(
    inspectReviewCohortDeclaration(input).declarationComplete,
    false,
  );
  input.grouping.holdoutFamilies = false;
  // Adjacent hexadecimal IDs share a long prefix but do not identify one lineage.
  assert.equal(inspectReviewCohortDeclaration(input).counts.components, 3);
});
test("cohort declaration refuses absent malformed duplicate and answer-bearing metadata", () => {
  for (const input of [
    undefined,
    {},
    { ...declaration(), cases: [] },
    { ...declaration(), answer: "original hidden answer" },
    { ...declaration(), referenceId: "named-reference" },
  ])
    assert.throws(() => inspectReviewCohortDeclaration(input));
  const input = declaration();
  input.cases[1]!.id = input.cases[0]!.id;
  assert.throws(() => inspectReviewCohortDeclaration(input), /Duplicate/);
  const extra = declaration();
  Object.assign(extra.cases[0]!, { previousVerdict: "defect" });
  assert.throws(() => inspectReviewCohortDeclaration(extra));
  const reasons = declaration();
  reasons.cases[0]!.disposition = {
    status: "excluded",
    reasons: ["out-of-scope", "out-of-scope"],
  };
  assert.throws(() => inspectReviewCohortDeclaration(reasons));
});
test("cohort declaration refuses a changed expected identity and retains the original parsed input", () => {
  const input = declaration(),
    original = structuredClone(input),
    receipt = inspectReviewCohortDeclaration(input);
  assert.equal(
    inspectReviewCohortDeclaration(input, receipt.declarationSha256)
      .declarationComplete,
    true,
  );
  assert.deepEqual(input, original);
  input.cases[0]!.sourceArchiveSha256 = sha(99);
  assert.throws(
    () => inspectReviewCohortDeclaration(input, receipt.declarationSha256),
    /identity changed/,
  );
  assert.deepEqual(
    inspectReviewCohortDeclaration(declaration()),
    inspectReviewCohortDeclaration(original),
  );
});
test("cohort declaration cannot admit unknown or inspected reserved exposure or selected missing notice metadata", () => {
  for (const exposure of ["unknown", "inspected"] as const) {
    const input = declaration();
    input.cases[2]!.exposure = exposure;
    const result = inspectReviewCohortDeclaration(input);
    assert.equal(result.declarationComplete, false);
    assert.equal(result.issues[0]?.kind, "exposure");
  }
  for (const field of ["license", "noticeSha256"] as const) {
    const input = declaration();
    input.cases[0]![field] = null;
    const result = inspectReviewCohortDeclaration(input);
    assert.equal(result.declarationComplete, false);
    assert.equal(result.issues[0]?.kind, "license-metadata");
  }
  const excluded = declaration();
  excluded.cases[0]!.noticeSha256 = null;
  excluded.cases[0]!.disposition = {
    status: "excluded",
    reasons: ["missing-notice"],
  };
  const result = inspectReviewCohortDeclaration(excluded);
  assert.equal(result.declarationComplete, true);
  assert.equal(result.counts.total, 3);
  assert.equal(
    result.counts.selected + result.counts.excluded,
    result.counts.total,
  );
});
test("cohort declaration summary omits all case source reference workflow and family identities while preserving denominators and issue meaning", () => {
  const input = declaration();
  input.cases[0]!.lineageId = input.cases[2]!.lineageId;
  const detailed = inspectReviewCohortDeclaration(input),
    summary = projectReviewCohortDeclaration(detailed),
    json = JSON.stringify(summary);
  assert.equal(summary.counts.total, 3);
  assert.deepEqual(summary.issues, [{ kind: "split-conflict", caseCount: 2 }]);
  for (const row of input.cases)
    for (const value of [
      row.id,
      row.lineageId,
      row.repositoryId,
      row.familyId,
      row.contentSha256,
    ])
      assert.equal(json.includes(value), false);
  assert.equal(json.includes(input.referenceId), false);
  assert.equal(json.includes(input.priorWorkflowId), false);
  assert.equal(summary.labelsInspected, false);
});

test("cohort declarations reconcile exclusion reasons and refuse selected private restricted unknown or retired cases", () => {
  for (const field of [
    "private-service",
    "restricted",
    "unknown-distribution",
    "out-of-scope",
    "retired",
  ]) {
    const input = declaration(),
      row = input.cases[0]!;
    if (field === "private-service") row.requiresPrivateService = true;
    if (field === "restricted") row.distribution = "restricted";
    if (field === "unknown-distribution") row.distribution = "unknown";
    if (field === "out-of-scope") row.inScope = false;
    if (field === "retired") row.split = "retired";
    const result = inspectReviewCohortDeclaration(input);
    assert.equal(result.declarationComplete, false);
    assert.equal(result.issues[0]?.kind, "eligibility", field);
  }
  for (const reason of [
    "missing-notice",
    "missing-license",
    "private-service",
    "undistributable-input",
    "unknown-distribution",
    "previous-exposure",
    "unknown-exposure",
    "out-of-scope",
  ] as const) {
    const input = declaration(),
      row = input.cases[0]!;
    row.disposition = { status: "excluded", reasons: [reason] };
    assert.equal(
      inspectReviewCohortDeclaration(input).issues[0]?.kind,
      "disposition",
      reason,
    );
    switch (reason) {
      case "missing-notice":
        row.noticeSha256 = null;
        break;
      case "missing-license":
        row.license = "NOASSERTION";
        break;
      case "private-service":
        row.requiresPrivateService = true;
        break;
      case "undistributable-input":
        row.distribution = "restricted";
        break;
      case "unknown-distribution":
        row.distribution = "unknown";
        break;
      case "previous-exposure":
        row.exposure = "inspected";
        break;
      case "unknown-exposure":
        row.exposure = "unknown";
        break;
      case "out-of-scope":
        row.inScope = false;
        break;
    }
    assert.equal(
      inspectReviewCohortDeclaration(input).declarationComplete,
      true,
      reason,
    );
  }
  for (const license of ["NONE", "NOASSERTION", "UNLICENSED"]) {
    const input = declaration();
    input.cases[0]!.license = license;
    assert.equal(
      inspectReviewCohortDeclaration(input).issues[0]?.kind,
      "license-metadata",
    );
  }
  const blank = declaration();
  blank.cases[0]!.license = " ";
  assert.throws(() => inspectReviewCohortDeclaration(blank));
});

test("cohort declaration bounds the selection and cannot report an all-excluded catalog as a complete review declaration", () => {
  const input = declaration();
  for (const row of input.cases) {
    row.inScope = false;
    row.disposition = { status: "excluded", reasons: ["out-of-scope"] };
  }
  const result = inspectReviewCohortDeclaration(input);
  assert.equal(result.declarationComplete, false);
  assert.equal(result.counts.total, 3);
  assert.equal(result.counts.selected, 0);
  assert.equal(result.counts.excluded, 3);
  assert.deepEqual(result.issues, [{ kind: "empty-selection", caseIds: [] }]);
  const bounded = declaration(),
    base = bounded.cases[0]!;
  bounded.cases = Array.from({ length: 256 }, (_, n) => ({
    ...base,
    id: "case-" + hex(n + 1),
    lineageId: "lineage-" + hex(n + 1),
    contentSha256: sha(n + 1),
  }));
  assert.equal(inspectReviewCohortDeclaration(bounded).counts.total, 256);
  bounded.cases.push({ ...base, id: "case-" + hex(257) });
  assert.throws(() => inspectReviewCohortDeclaration(bounded), /case bound/);
});

test("cohort setup checker bounds stdin and returns only declaration summaries while retaining invalid incomplete and stale outcomes", () => {
  const script = fileURLToPath(
    new URL("../../scripts/check-evaluation-cohort.mjs", import.meta.url),
  );
  const run = (input: string | Buffer, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], {
      input,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1048576,
    });
  const input = declaration(),
    first = run(JSON.stringify(input));
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.declarationComplete, true);
  assert.equal(result.counts.total, 3);
  assert.equal(first.stdout.includes(input.cases[0]!.id), false);
  assert.equal(result.inferenceExecuted, false);
  assert.equal(result.labelsInspected, false);
  assert.equal(
    run(JSON.stringify(input), [
      "--expected-declaration-sha256",
      result.declarationSha256,
    ]).status,
    0,
  );
  input.cases[2]!.exposure = "unknown";
  const incomplete = run(JSON.stringify(input));
  assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).declarationComplete, false);
  assert.equal(JSON.parse(incomplete.stdout).counts.total, 3);
  const stale = run(JSON.stringify(input), [
    "--expected-declaration-sha256",
    result.declarationSha256,
  ]);
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout, "");
  for (const [body, args] of [
    ["{original-private-secret", []],
    [
      JSON.stringify({ ...declaration(), answer: "original-private-secret" }),
      [],
    ],
    ["x".repeat(1048577), []],
    [Buffer.from([0xff]), []],
    [
      JSON.stringify(declaration()),
      ["--expected-declaration-sha256", "original-private-secret"],
    ],
  ] as [string | Buffer, string[]][]) {
    const refused = run(body, args);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, "Cohort declaration invalid or unavailable\n");
  }
});

test("cohort main library exports retain schema inspection projection and declared report types", () => {
  assert.equal(
    typeof library.inspectReviewCohortDeclaration,
    "function",
    "inspectReviewCohortDeclaration",
  );
  assert.equal(
    typeof library.projectReviewCohortDeclaration,
    "function",
    "projectReviewCohortDeclaration",
  );
  assert.equal(
    typeof library.reviewCohortDeclarationSchema,
    "object",
    "reviewCohortDeclarationSchema",
  );
  const input: ReviewCohortDeclaration = declaration();
  assert.deepEqual(library.reviewCohortDeclarationSchema.parse(input), input);
  const report: ReviewCohortDeclarationReport =
    library.inspectReviewCohortDeclaration(input);
  assert.deepEqual(report, inspectReviewCohortDeclaration(input));
  assert.deepEqual(
    library.projectReviewCohortDeclaration(report),
    projectReviewCohortDeclaration(report),
  );
  assert.equal(report.declarationComplete, true);
  assert.equal(report.fieldEvaluationExecuted, false);
});

test("cohort declaration checks every identity and digest boundary with valid near misses", () => {
  const globalIds = [
    ["referenceId", "reference"],
    ["priorWorkflowId", "workflow"],
  ] as const;
  const caseIds = [
    ["id", "case"],
    ["repositoryId", "repository"],
    ["familyId", "family"],
    ["lineageId", "lineage"],
  ] as const;
  for (const [field, kind] of [...globalIds, ...caseIds]) {
    const inputWith = (value: string) => {
      const input = declaration();
      if (field === "referenceId" || field === "priorWorkflowId")
        input[field] = value;
      else input.cases[0]![field] = value;
      return input;
    };
    for (const value of [
      kind + "-" + "a".repeat(31),
      kind + "-" + "a".repeat(33),
      "other-" + "a".repeat(32),
      kind + "-" + "g".repeat(32),
      kind + "-" + "A".repeat(32),
      kind + "-" + "a".repeat(32) + "\n",
    ]) {
      const input = inputWith(value);
      assert.equal(
        reviewCohortDeclarationSchema.safeParse(input).success,
        false,
        field,
      );
      assert.throws(() => inspectReviewCohortDeclaration(input), {
        name: "ZodError",
      });
    }
    for (const char of ["0", "f"])
      assert.equal(
        inspectReviewCohortDeclaration(inputWith(kind + "-" + char.repeat(32)))
          .declarationComplete,
        true,
        field,
      );
  }
  const invalidHashes = [
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    "A".repeat(64),
    "a".repeat(64) + "\n",
  ];
  for (const field of [
    "contentSha256",
    "sourceArchiveSha256",
    "noticeSha256",
  ] as const) {
    for (const value of invalidHashes) {
      const input = declaration();
      input.cases[0]![field] = value;
      assert.equal(
        reviewCohortDeclarationSchema.safeParse(input).success,
        false,
        field,
      );
      assert.throws(() => inspectReviewCohortDeclaration(input), {
        name: "ZodError",
      });
    }
    for (const char of ["0", "f"]) {
      const input = declaration();
      input.cases[0]![field] = char.repeat(64);
      assert.equal(
        inspectReviewCohortDeclaration(input).declarationComplete,
        true,
        field,
      );
    }
  }
  const input = declaration();
  for (const value of invalidHashes)
    assert.throws(() => inspectReviewCohortDeclaration(input, value), {
      name: "ZodError",
    });
  for (const char of ["0", "f"])
    assert.throws(
      () => inspectReviewCohortDeclaration(input, char.repeat(64)),
      /Cohort declaration identity changed/,
    );
  const report = inspectReviewCohortDeclaration(input);
  assert.deepEqual(
    inspectReviewCohortDeclaration(input, report.declarationSha256),
    report,
  );
});
