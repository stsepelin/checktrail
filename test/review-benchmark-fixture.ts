import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, chmod, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ReviewBenchmark,
  freezeReviewBenchmark,
} from "../src/review-benchmark.js";
import {
  reviewBenchmarkJudgingSchema,
  reviewBenchmarkJudgePacketSchema,
  reviewBenchmarkJudgmentArchiveSchema,
  type ReviewBenchmarkJudgmentResponse,
  type ReviewBenchmarkPlan,
} from "../src/review-benchmark-schema.js";
import { ReviewWorkflowSession } from "../src/review-workflow-session.js";
import {
  reviewWorkflowLimitsSchema,
  reviewWorkflowAssignmentSchema,
  reviewWorkflowSummarySchema,
} from "../src/review-workflow-schema.js";
import {
  setup,
  pin,
  response,
  limits,
  source,
} from "./review-workflow-fixture.js";
export const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const privateCase = "OriginalCuratorCaseCanary";
export const privateGroup = "OriginalCuratorGroupCanary";
export const privateAnswer = "OriginalHiddenAnswerCanary";
export async function prepare(
  t: TestContext,
  count = 1,
  repetitions = 1,
  native = false,
  judging = false,
  scoring = false,
  scoringFamily: NonNullable<
    ReviewBenchmarkPlan["scoring"]
  >["cases"][number]["family"] = "identifiers-allowlists",
  multi = false,
) {
  const cases = [];
  for (let i = 0; i < count; i++) {
    const code =
      i === 0
        ? source +
          (multi
            ? "export function recipient(verified){return verified !== false;}\n"
            : "")
        : i === 1
          ? "export function decision(name){return name.startsWith('grant:');}\n"
          : "export function decision(name){return name === 'grant:read';}\n";
    cases.push(await setup(t, code));
  }
  const operator = await mkdtemp(
    path.join(tmpdir(), "checktrail-original-benchmark-"),
  );
  await chmod(operator, 0o700);
  t.after(() => rm(operator, { recursive: true, force: true }));
  const host = {
    client: "original-any-ai-host",
    clientVersion: "fixture-1",
    provider: "operator-chosen-provider",
    model: "fictional-exact-model",
  };
  const settings = {
    allowReviewSource: true as const,
    trusted: native,
    workflowLimits: { ...limits, maxWorkflows: 1 },
    nativeWallMs: 30000,
    maxNativeOutputBytes: 65536,
    nativeBudget: { maxCalls: 16, maxOutputBytes: 65536 },
    probes: native ? [{ id: "OriginalWorkflow", sha256: pin().sha256 }] : [],
  };
  const plan: ReviewBenchmarkPlan = {
    schemaVersion: 1,
    profile: "workflow-journal-paired-synthetic-v1",
    provenance: "operator-declared-original-synthetic",
    curatorSessionId: "OriginalCuratorSessionCanary",
    ...(judging
      ? {
          judging: {
            instructions:
              "Judge the supplied source and every claim independently. Leave unknown outcomes unresolved.",
            host: { ...host, model: "fictional-independent-judge" },
          },
        }
      : {}),
    repetitions,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    arms: [
      {
        id: "OriginalArmA",
        instructions: "Review independently under declared condition A.",
        settings,
        host,
      },
      {
        id: "OriginalArmB",
        instructions: "Review independently under declared condition B.",
        settings: structuredClone(settings),
        host,
      },
    ],
    cases: cases.map((c, i) => ({
      id: `${privateCase}${i}`,
      group: privateGroup,
      context: c.context,
      labels: {
        variant: i === 0 ? "broken" : i === 1 ? "fixed" : "near-miss",
        expectedDefects:
          i === 0
            ? [
                {
                  id: privateAnswer,
                  claim: "The synthetic prefix admits grantToken.",
                },
                ...(multi
                  ? [
                      {
                        id: "OriginalSecondDefect",
                        claim:
                          "The synthetic recipient accepts an absent verification value.",
                      },
                    ]
                  : []),
              ]
            : [],
      },
    })),
  };
  if (scoring)
    plan.scoring = {
      profile: "sealed-single-claim-paired-synthetic-v1",
      seed: "b".repeat(64),
      resamples: 128,
      confidenceLevel: 0.95,
      cases: plan.cases.map((c) => ({
        id: c.id,
        family: scoringFamily,
      })),
    };
  if (multi)
    plan.multiScoring = {
      profile: "sealed-multi-claim-paired-synthetic-v1",
      seed: "c".repeat(64),
      resamples: 128,
      confidenceLevel: 0.95,
      matching: {
        instructions:
          "Match each blind claim to the common declared defect inventory; leave ambiguous matches unresolved.",
        host: { ...host, model: "fictional-independent-matcher" },
      },
      cases: plan.cases.map((c) => ({
        id: c.id,
        defects: c.labels.expectedDefects.map((d) => ({
          id: d.id,
          family:
            d.id === "OriginalSecondDefect"
              ? "authorization-tenancy"
              : "identifiers-allowlists",
          material: true,
        })),
      })),
    };
  const frozen = freezeReviewBenchmark(
    cases[0]!.root,
    plan,
    path.join(operator, "run"),
  );
  const benchmark = new ReviewBenchmark(cases[0]!.root, frozen.reference);
  const manifest = JSON.parse(
    await readFile(
      path.join(frozen.reference.directory, "manifest.json"),
      "utf8",
    ),
  ) as {
    trials: {
      trialId: string;
      caseIndex: number;
      armIndex: number;
      blindId: string;
      matchingId?: string;
    }[];
  };
  return { ...frozen, benchmark, operator, cases, plan, manifest };
}
export type Prepared = Awaited<ReturnType<typeof prepare>>;
export async function runTrial(
  t: TestContext,
  fixture: Prepared,
  index: number,
  mode: "empty" | "native" | "malformed" | "refused" | "cancelled" = "empty",
  sessionId?: string,
  sourceCaseIndex?: number,
  model?: string,
  candidateCount = 1,
  confidence?: import("../src/review-provider-schema.js").ReviewCandidate["confidence"],
) {
  const trial = fixture.manifest.trials[index]!,
    c = fixture.cases[sourceCaseIndex ?? trial.caseIndex]!;
  // Every trial gets fresh source storage; identical contexts must not depend on its absolute location.
  const fresh = await setup(t, c.context.files[0]!.content);
  assert.equal(fresh.context.contextDigest, c.context.contextDigest);
  if (confidence !== undefined) fresh.target.confidence = confidence;
  const startup = fixture.benchmark.trialSetup(trial.trialId);
  const session = new ReviewWorkflowSession(fresh.root, {
    allowReviewSource: true,
    trusted: startup.settings.trusted,
    limits: reviewWorkflowLimitsSchema.parse(
      fixture.plan.arms[trial.armIndex]!.settings.workflowLimits,
    ),
    nativeWallMs: startup.settings.nativeWallMs,
    maxNativeOutputBytes: startup.settings.maxNativeOutputBytes,
    nativeBudget: startup.settings.nativeBudget,
    probes: startup.settings.probes.length ? [pin()] : [],
    audit: startup.audit,
  });
  try {
    const opened = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "open",
        context: ".checktrail/context.json",
      }),
    );
    const assignment = reviewWorkflowAssignmentSchema.parse(
      await session.command({
        operation: "next",
        workflowId: opened.workflowId,
      }),
    );
    const submission = response(
      assignment,
      mode === "native"
        ? Array.from({ length: candidateCount }, (_, i) =>
            i === 0
              ? fresh.target
              : {
                  ...fresh.target,
                  id: fresh.target.id + "-" + i,
                  ...(fixture.plan.multiScoring &&
                  trial.caseIndex === 0 &&
                  i === 2
                    ? {
                        family: "authorization-tenancy" as const,
                        claim:
                          "The recipient decision admits an absent verification value.",
                        trigger: "Call recipient(undefined).",
                        citations: [
                          {
                            ...fresh.target.citations[0]!,
                            startLine: 2,
                            endLine: 2,
                            quote:
                              c.context.files[0]!.content.split("\n")[1] ??
                              c.context.files[0]!.content.split("\n")[0]!,
                          },
                        ],
                      }
                    : {}),
                },
          )
        : [],
    );
    if (sessionId) submission.host.sessionId = sessionId;
    if (model) submission.host.model = model;
    if (mode === "refused" || mode === "cancelled") {
      submission.status = mode;
      submission.output = null;
    }
    const input =
      mode === "malformed"
        ? {
            ...submission,
            originalMalformedCanary: "OriginalRejectedAttemptCanary",
          }
        : submission;
    let result = reviewWorkflowSummarySchema.parse(
      await session.command({
        operation: "submit",
        workflowId: opened.workflowId,
        response: input,
      }),
    );
    if (mode === "native") {
      // A replay must remain in the raw archive without duplicating the accepted finding in judging.
      await assert.rejects(
        session.command({
          operation: "submit",
          workflowId: opened.workflowId,
          response: input,
        }),
        /No available host assignment/,
      );
      let refuter = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: opened.workflowId,
          target: result.candidateHandles[0],
        }),
      );
      const replay = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "submit",
          workflowId: opened.workflowId,
          response: input,
        }),
      );
      assert.equal(replay.assignments.at(-1)!.status, "invalid-binding");
      refuter = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: opened.workflowId,
          target: result.candidateHandles[0],
        }),
      );
      await session.command({
        operation: "submit",
        workflowId: opened.workflowId,
        response: response(refuter),
      });
      result = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "probe",
          workflowId: opened.workflowId,
          probeId: "OriginalWorkflow",
        }),
      );
      const adjudicator = reviewWorkflowAssignmentSchema.parse(
        await session.command({
          operation: "next",
          workflowId: result.workflowId,
        }),
      );
      result = reviewWorkflowSummarySchema.parse(
        await session.command({
          operation: "submit",
          workflowId: result.workflowId,
          response: response(adjudicator),
        }),
      );
      assert.equal(result.disposition, "advisory-stages-completed");
    } else if (mode === "empty")
      assert.equal(result.disposition, "no-candidates-declared");
  } finally {
    session.dispose();
  }
  return startup.audit.file;
}
export function noPrivate(text: string, fixture: Prepared) {
  for (const value of [
    privateCase,
    privateGroup,
    privateAnswer,
    fixture.plan.curatorSessionId,
    "OriginalArmA",
    "OriginalArmB",
    fixture.operator,
  ])
    assert.equal(text.includes(value), false, value);
}
export async function privateJson(filename: string, value: unknown) {
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
}
export async function prepareJudgments(
  t: TestContext,
  count = 1,
  repetitions = 1,
  native = false,
  scoring = false,
  confidenceValues?: (number | null | undefined)[],
) {
  const f = await prepare(t, count, repetitions, native, true, scoring);
  for (let i = 0; i < f.manifest.trials.length; i++)
    await runTrial(
      t,
      f,
      i,
      native ? "native" : "empty",
      `original-review-session-${i}`,
      undefined,
      undefined,
      1,
      confidenceValues?.[
        f.manifest.trials[i]!.caseIndex * 2 + f.manifest.trials[i]!.armIndex
      ] === undefined
        ? undefined
        : {
            profile: "declared-claim-support-probability-v1",
            event: "supported-in-scope-actionable",
            probability:
              confidenceValues[
                f.manifest.trials[i]!.caseIndex * 2 +
                  f.manifest.trials[i]!.armIndex
              ]!,
            calibratedConfidence: false,
          },
    );
  f.benchmark.collect();
  f.benchmark.prepareJudging();
  const book = reviewBenchmarkJudgingSchema.parse(
    JSON.parse(
      await readFile(path.join(f.reference.directory, "judging.json"), "utf8"),
    ),
  );
  return { ...f, book };
}
export function judgmentResponse(
  f: Prepared,
  blindId: string,
): ReviewBenchmarkJudgmentResponse {
  const packet = reviewBenchmarkJudgePacketSchema.parse(
    f.benchmark.judgeWorkerCommand({ operation: "packet" }, true, blindId),
  );
  const file = packet.evidence.context.files[0]!;
  const citation = {
    file: file.path,
    revision: "current" as const,
    sourceDigest: file.sha256,
    startLine: 1,
    endLine: 1,
    quote: file.content.split("\n")[0]!,
  };
  return {
    schemaVersion: 1,
    blindId,
    assignmentDigest: packet.assignmentDigest,
    host: {
      ...f.plan.judging!.host,
      sessionId: randomUUID(),
      isolation: "fresh",
    },
    status: "completed",
    usage: {
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
      costUSD: null,
    },
    output: {
      label: "defect",
      rationale: "Original synthetic source-bound judgment declaration.",
      citations: [citation],
      claims: packet.claims.map((c) => ({
        claimId: c.claimId,
        judgement: "supported",
        rationale: "Original synthetic supported declaration.",
        citations: c.candidate.citations.map((c) => structuredClone(c)),
      })),
    },
  };
}
export async function putJudgment(
  f: Prepared,
  blindId: string,
  value: unknown,
) {
  await privateJson(f.benchmark.judgeSetup(blindId).file, value);
}
export async function judgmentArchive(f: Prepared) {
  return reviewBenchmarkJudgmentArchiveSchema.parse(
    JSON.parse(
      await readFile(
        path.join(f.reference.directory, "judgments-sealed.json"),
        "utf8",
      ),
    ),
  );
}
