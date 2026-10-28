import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as library from "../src/index.js";
import {
  inspectReviewEvaluationProtocol,
  projectReviewEvaluationProtocol,
} from "../src/review-evaluation-protocol.js";
import {
  protocolFixture,
  bindProtocolCohort,
  protocolHex,
  protocolSha,
} from "./review-evaluation-protocol-fixture.js";
const inspect = inspectReviewEvaluationProtocol;
const script = fileURLToPath(
  new URL("../../scripts/check-evaluation-protocol.mjs", import.meta.url),
);

test("evaluation protocol binds the common cohort reference and prior workflow without opening inputs or claiming freeze authority", () => {
  const input = protocolFixture();
  const original = structuredClone(input);
  const report = inspect(input);
  assert.equal(report.declarationComplete, true);
  assert.equal(report.baselineKind, "declared-comparison-baseline");
  const previous = structuredClone(input);
  previous.protocol.priorWorkflow.kind = "previous-workflow";
  const previousReport = inspect(previous);
  assert.equal(previousReport.declarationComplete, true);
  assert.equal(previousReport.baselineKind, "previous-workflow");
  assert.equal(previousReport.configurationBytesVerified, false);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.counts, {
    totalCases: 3,
    selectedCases: 3,
    excludedCases: 0,
    selectedClusters: 3,
    pairedTrialsPerComparison: 6,
    plannedArmSlots: 18,
  });
  assert.deepEqual(input, original);
  for (const name of [
    "sourceContentInspected",
    "labelsInspected",
    "configurationBytesVerified",
    "chronologyVerified",
    "licenseGrantVerified",
    "hostIndependenceVerified",
    "qualityAssessed",
    "gateAClosed",
    "inferenceExecuted",
    "fieldEvaluationExecuted",
  ] as const)
    assert.equal(report[name], false, name);
  assert.equal(
    library.inspectReviewEvaluationProtocol(input).protocolSha256,
    report.protocolSha256,
  );
  assert.deepEqual(
    library.projectReviewEvaluationProtocol(report),
    projectReviewEvaluationProtocol(report),
  );
});

test("evaluation protocol rejects stale cohort and foreign reference or previous workflow bindings independently", () => {
  for (const [kind, change] of [
    [
      "cohort-binding",
      (v: ReturnType<typeof protocolFixture>) => {
        v.protocol.cohortDeclarationSha256 = protocolSha(9999);
      },
    ],
    [
      "reference-binding",
      (v: ReturnType<typeof protocolFixture>) => {
        v.protocol.reference.id = "reference-" + protocolHex(9999);
      },
    ],
    [
      "prior-workflow-binding",
      (v: ReturnType<typeof protocolFixture>) => {
        v.protocol.priorWorkflow.id = "workflow-" + protocolHex(9999);
      },
    ],
  ] as const) {
    const input = protocolFixture();
    change(input);
    const report = inspect(input);
    assert.equal(report.declarationComplete, false);
    assert.deepEqual(report.issues, [kind]);
    assert.equal(report.counts.plannedArmSlots, 18);
  }
  const changed = protocolFixture();
  changed.cohort.cases[0]!.sourceArchiveSha256 = protocolSha(9999);
  assert.deepEqual(inspect(changed).issues, ["cohort-binding"]);
});

test("evaluation protocol keeps excluded connecting variants in transitive incident clusters", () => {
  const input = protocolFixture(4);
  input.cohort.cases[0]!.contentSha256 = input.cohort.cases[1]!.contentSha256;
  input.cohort.cases[1]!.lineageId = input.cohort.cases[2]!.lineageId;
  input.cohort.cases[1]!.disposition = {
    status: "excluded",
    reasons: ["out-of-scope"],
  };
  input.cohort.cases[1]!.inScope = false;
  bindProtocolCohort(input);
  const broken = inspect(input);
  assert.equal(broken.declarationComplete, false);
  assert.deepEqual(broken.issues, ["cluster-split"]);
  assert.deepEqual(broken.counts, {
    totalCases: 4,
    selectedCases: 3,
    excludedCases: 1,
    selectedClusters: 3,
    pairedTrialsPerComparison: 6,
    plannedArmSlots: 18,
  });
  for (const n of [1, 2])
    input.protocol.caseClusters[n]!.clusterId =
      input.protocol.caseClusters[0]!.clusterId;
  const repaired = inspect(input);
  assert.equal(repaired.declarationComplete, true);
  assert.equal(repaired.counts.selectedClusters, 2);
  assert.equal(repaired.counts.totalCases, broken.counts.totalCases);
  assert.equal(repaired.counts.plannedArmSlots, broken.counts.plannedArmSlots);
});

test("evaluation protocol applies repository and family holdouts by exact identifiers and refuses split cluster declarations", () => {
  for (const kind of ["repository", "family"] as const) {
    const input = protocolFixture();
    if (kind === "repository") {
      input.cohort.grouping.holdoutRepositories = true;
      input.cohort.cases[1]!.repositoryId = input.cohort.cases[0]!.repositoryId;
    } else {
      input.cohort.grouping.holdoutFamilies = true;
      input.cohort.cases[1]!.familyId = input.cohort.cases[0]!.familyId;
    }
    bindProtocolCohort(input);
    assert.deepEqual(inspect(input).issues, ["cluster-split"]);
    input.protocol.caseClusters[1]!.clusterId =
      input.protocol.caseClusters[0]!.clusterId;
    assert.equal(inspect(input).declarationComplete, true);
  }
  // Adjacent opaque identifiers are different incidents, not prefix matches.
  assert.equal(inspect(protocolFixture()).counts.selectedClusters, 3);
});

test("evaluation protocol refuses duplicate foreign and omitted cluster addresses while preserving the whole planned denominator", () => {
  for (const mode of ["duplicate", "foreign", "missing"] as const) {
    const input = protocolFixture();
    if (mode === "duplicate")
      input.protocol.caseClusters[1]!.caseId =
        input.protocol.caseClusters[0]!.caseId;
    else if (mode === "foreign")
      input.protocol.caseClusters[1]!.caseId = "case-" + protocolHex(9999);
    else input.protocol.caseClusters.pop();
    const report = inspect(input);
    assert.equal(report.declarationComplete, false);
    assert.ok(report.issues.includes("cluster-inventory"));
    assert.equal(report.counts.selectedCases, 3);
    assert.equal(report.counts.pairedTrialsPerComparison, 6);
    assert.equal(report.counts.plannedArmSlots, 18);
    assert.ok(report.schedule.length * 3 < report.counts.plannedArmSlots);
  }
});

test("evaluation protocol requires reserved uninspected eligible cases and sufficient declared incident clusters", () => {
  const development = protocolFixture();
  development.cohort.cases[0]!.split = "development";
  bindProtocolCohort(development);
  assert.deepEqual(inspect(development).issues, ["selected-not-reserved"]);
  for (const change of [
    (v: ReturnType<typeof protocolFixture>) => {
      v.cohort.cases[0]!.exposure = "inspected";
    },
    (v: ReturnType<typeof protocolFixture>) => {
      v.cohort.cases[0]!.noticeSha256 = null;
    },
    (v: ReturnType<typeof protocolFixture>) => {
      v.cohort.cases[0]!.license = "NOASSERTION";
    },
    (v: ReturnType<typeof protocolFixture>) => {
      v.cohort.cases[0]!.requiresPrivateService = true;
    },
    (v: ReturnType<typeof protocolFixture>) => {
      v.cohort.cases[0]!.distribution = "restricted";
    },
  ]) {
    const input = protocolFixture();
    change(input);
    bindProtocolCohort(input);
    const report = inspect(input);
    assert.equal(report.declarationComplete, false);
    assert.ok(report.issues.includes("cohort-incomplete"));
  }
  const single = protocolFixture();
  for (const row of single.protocol.caseClusters)
    row.clusterId = single.protocol.caseClusters[0]!.clusterId;
  assert.deepEqual(inspect(single).issues, ["insufficient-selected-clusters"]);
  for (const row of single.cohort.cases) {
    row.disposition = { status: "excluded", reasons: ["out-of-scope"] };
    row.inScope = false;
  }
  bindProtocolCohort(single);
  const empty = inspect(single);
  assert.equal(empty.declarationComplete, false);
  assert.equal(empty.counts.totalCases, 3);
  assert.equal(empty.counts.selectedCases + empty.counts.excludedCases, 3);
  assert.equal(empty.schedule.length, 0);
});

test("evaluation protocol rotates every three-arm order exactly once at six pairs and retains stable orders across metadata array permutations", () => {
  const input = protocolFixture();
  const report = inspect(input);
  assert.equal(report.schedule.length, 6);
  assert.equal(
    new Set(report.schedule.map((row) => JSON.stringify(row.order))).size,
    6,
  );
  for (const role of ["baseline", "verifier", "reference"] as const)
    for (let position = 0; position < 3; position++)
      assert.equal(
        report.schedule.filter((row) => row.order[position] === role).length,
        2,
      );
  input.protocol.caseClusters.reverse();
  input.cohort.cases.reverse();
  bindProtocolCohort(input);
  assert.deepEqual(inspect(input).schedule, report.schedule);
  input.protocol.scoring.repetitions = 1;
  const once = inspect(input);
  assert.equal(once.schedule.length, 3);
  assert.equal(once.counts.plannedArmSlots, 9);
  const maximum = inspect(protocolFixture(256));
  assert.equal(maximum.declarationComplete, true);
  assert.equal(maximum.schedule.length, 512);
  assert.equal(maximum.counts.plannedArmSlots, 1536);
});

test("evaluation protocol pins every configuration procedure budget and threshold without silently accepting a later revision", () => {
  const input = protocolFixture();
  const expected = inspect(input).protocolSha256;
  assert.equal(inspect(input, expected).declarationComplete, true);
  const changes = [
    (v: typeof input) => {
      v.protocol.priorWorkflow.kind = "previous-workflow";
    },
    (v: typeof input) => {
      v.protocol.verifierConfigurationSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.priorWorkflow.configurationSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.reference.configurationSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.implementation.packageLockSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.implementation.engineArtifactsSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.procedures.externalMeteringSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.procedures.independentJudgmentSha256 = protocolSha(9999);
    },
    (v: typeof input) => {
      v.protocol.budgets.wallMsPerArm++;
    },
    (v: typeof input) => {
      v.protocol.scoring.thresholds.maximumRecallNoninferiorityMargin = 0.03;
    },
    (v: typeof input) => {
      v.protocol.scoring.seed = protocolSha(9999);
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(input);
    change(changed);
    assert.throws(
      () => inspect(changed, expected),
      /protocol identity changed/,
    );
  }
  assert.equal(inspect(input, expected).protocolSha256, expected);
});

test("evaluation protocol refuses answer fields identity aliases malformed commitments floating fields and out-of-bound numeric decisions", () => {
  const input = protocolFixture();
  for (const change of [
    (v: typeof input) => {
      Reflect.deleteProperty(v.protocol.priorWorkflow, "kind");
    },
    (v: typeof input) => {
      Object.assign(v.protocol.priorWorkflow, { kind: "assumed-history" });
    },
    (v: typeof input) => {
      Object.assign(v.protocol, { answer: "OriginalHiddenProtocolAnswer" });
    },
    (v: typeof input) => {
      Object.assign(v.cohort.cases[0]!, { label: "broken" });
    },
    (v: typeof input) => {
      Object.assign(v.protocol, { allowInference: true });
    },
    (v: typeof input) => {
      v.protocol.priorWorkflow.id = "workflow-" + protocolHex(1) + "suffix";
    },
    (v: typeof input) => {
      v.protocol.implementation.sourceCommit = "main";
    },
    (v: typeof input) => {
      v.protocol.procedures.hostIsolationSha256 = "latest";
    },
    (v: typeof input) => {
      v.protocol.budgets.wallMsPerArm = 0;
    },
    (v: typeof input) => {
      v.protocol.budgets.toolCallsPerArm = 10001;
    },
    (v: typeof input) => {
      v.protocol.scoring.thresholds.minimumCompletedCoverage = 1.01;
    },
    (v: typeof input) => {
      v.protocol.scoring.repetitions = 3;
    },
    (v: typeof input) => {
      v.protocol.scoring.minimumClusters = 1;
    },
    (v: typeof input) => {
      v.protocol.scoring.resamples = 127;
    },
    (v: typeof input) => {
      v.protocol.scoring.confidenceLevel = 0.999;
    },
    (v: typeof input) => {
      v.protocol.caseClusters.push(
        ...Array(257).fill(v.protocol.caseClusters[0]!),
      );
    },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.throws(() => inspect(changed));
  }
});

test("evaluation protocol projection excludes private schedules and unrecognized nested fields", () => {
  const report = inspect(protocolFixture());
  Object.assign(report, {
    privateConfig: "OriginalPrivateProtocolConfig",
    gateAClosed: true,
  });
  Object.assign(report.counts, { hiddenAnswer: "OriginalPrivateCountPayload" });
  const summary = projectReviewEvaluationProtocol(report),
    encoded = JSON.stringify(summary);
  assert.equal(summary.privateIdentitiesIncluded, false);
  assert.equal(summary.sourceIncluded, false);
  assert.equal(summary.gateAClosed, false);
  for (const canary of [
    "OriginalPrivateProtocolConfig",
    "OriginalPrivateCountPayload",
    "case-",
    "cluster-",
    '"schedule"',
  ])
    assert.equal(encoded.includes(canary), false, canary);
  assert.deepEqual(summary.counts, {
    totalCases: 3,
    selectedCases: 3,
    excludedCases: 0,
    selectedClusters: 3,
    pairedTrialsPerComparison: 6,
    plannedArmSlots: 18,
  });
});

test("evaluation protocol setup script retains incomplete exit status and generic private error boundaries", () => {
  const input = protocolFixture();
  const call = (body: string | Buffer, args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], {
      input: body,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1048576,
    });
  const passed = call(JSON.stringify(input));
  assert.equal(passed.status, 0, passed.stderr);
  const summary = JSON.parse(passed.stdout);
  assert.equal(summary.declarationComplete, true);
  const exactBody = JSON.stringify(input);
  const exact = call(
    Buffer.concat([
      Buffer.from(exactBody),
      Buffer.alloc(1048576 - Buffer.byteLength(exactBody), 32),
    ]),
  );
  assert.equal(exact.status, 0, exact.stderr);
  assert.deepEqual(JSON.parse(exact.stdout), summary);
  assert.equal(passed.stdout.includes('"schedule"'), false);
  assert.equal(passed.stdout.includes("workflow-"), false);
  input.protocol.reference.id = "reference-" + protocolHex(9999);
  const incomplete = call(JSON.stringify(input));
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.deepEqual(JSON.parse(incomplete.stdout).issues, ["reference-binding"]);
  const wrongDigest = call(JSON.stringify(protocolFixture()), [
    "--expected-protocol-sha256",
    protocolSha(9999),
  ]);
  assert.equal(wrongDigest.status, 1);
  const valid = call(JSON.stringify(protocolFixture()), [
    "--expected-protocol-sha256",
    summary.protocolSha256,
  ]);
  assert.equal(valid.status, 0, valid.stderr);
  for (const [body, args] of [
    [JSON.stringify({ ...input, secret: "OriginalProtocolPrivateCanary" }), []],
    [JSON.stringify(input), ["--allow-inference"]],
    ["{OriginalProtocolPrivateCanary", []],
    [Buffer.from([255]), []],
    [Buffer.alloc(1048577, 32), []],
  ] as [string | Buffer, string[]][]) {
    const result = call(body, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Evaluation protocol declaration invalid or unavailable\n",
    );
  }
});

test(
  "evaluation protocol controls run through a fresh offline production installation with an external harness",
  { timeout: 180000 },
  async () => {
    if (process.env.CHECKTRAIL_EVALUATION_PROTOCOL_INSTALLED === "1") {
      const entry = await realpath(
        fileURLToPath(
          new URL("../src/review-evaluation-protocol.js", import.meta.url),
        ),
      );
      assert.ok(
        entry.includes(
          path.join("node_modules", "@stsepelin", "checktrail", "dist", "src"),
        ),
      );
      return;
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const verifier = fileURLToPath(
      new URL(
        "../../scripts/verify-evaluation-protocol-package.mjs",
        import.meta.url,
      ),
    );
    const result = spawnSync(process.execPath, [verifier], {
      env,
      encoding: "utf8",
      timeout: 150000,
      maxBuffer: 4 * 1048576,
    });
    assert.equal(result.status, 0, result.stderr);
    const packet = JSON.parse(result.stdout);
    assert.equal(packet.offlineProductionInstall, true);
    assert.equal(packet.lifecycleScriptsExecuted, false);
    assert.equal(packet.harnessOutsideInstalledPackage, true);
    assert.equal(packet.profileEvidence.complete, true);
    assert.equal(packet.profileEvidence.required, 12);
    assert.equal(packet.profileEvidence.passed, 12);
    assert.equal(packet.profileEvidence.ledger.cases.length, 12);
    assert.ok(
      packet.profileEvidence.ledger.cases.every(
        (row: { outcome: string }) => row.outcome === "passed",
      ),
    );
    assert.equal(packet.independentEvaluationProfileComplete, false);
    assert.equal(packet.gateAComplete, false);
  },
);
