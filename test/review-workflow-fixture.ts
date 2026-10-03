import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createReviewContext } from "../src/review.js";
import type { ReviewCandidate } from "../src/review-provider-schema.js";
import type { ReviewProbeRecipe } from "../src/review-probe-schema.js";
import type {
  ReviewWorkflowAssignment,
  ReviewWorkflowResponse,
  ReviewWorkflowLimits,
} from "../src/review-workflow-schema.js";
import { fixture } from "./helpers.js";
export const source =
  "export function decision(name){return name.startsWith('grant');}\n";
export const limits: ReviewWorkflowLimits = {
  maxWorkflows: 8,
  maxAssignments: 6,
  wallMs: 30000,
  maxPacketBytes: 524288,
  maxResponseBytes: 131072,
  maxRetainedBytes: 4194304,
};
export const recipe: ReviewProbeRecipe = {
  schemaVersion: 1,
  profile: "node-export-boolean-v1",
  id: "OriginalWorkflow",
  family: "identifiers-allowlists",
  file: "subject.mjs",
  exportName: "decision",
  minimumTriggerScale: 1,
  guard: null,
  cases: [
    { id: "Baseline", role: "baseline", args: ["grant:read"], expected: true },
    { id: "Trigger", role: "trigger", args: ["grantToken"], expected: false },
    { id: "NearMiss", role: "near-miss", args: ["other"], expected: false },
  ],
};
export const pin = () => {
  const contents = JSON.stringify(recipe);
  return {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
};
export async function setup(
  t: Parameters<typeof fixture>[0],
  content = source,
) {
  const root = await fixture(t, {
    "subject.mjs": content,
    ".checktrail/keep": "",
  });
  const context = await createReviewContext(root, {
    schemaVersion: 5,
    track: "snapshot",
    currentSource: "working-tree",
    files: ["subject.mjs"],
    supportFiles: [],
    topics: [],
  });
  const target: ReviewCandidate = {
    id: "OriginalReviewerTargetIdentity",
    family: "identifiers-allowlists",
    severity: "concern",
    claim:
      "The declared triggering identifier may violate the expected boundary.",
    trigger: "Pass grantToken.",
    consequence: "Production impact remains unestablished.",
    evidenceGaps: ["Need production caller and intended policy."],
    attribution: "unknown",
    fixScope: "unknown",
    citations: [
      {
        file: "subject.mjs",
        revision: "current",
        sourceDigest: context.files[0]!.sha256,
        startLine: 1,
        endLine: content.trimEnd().split("\n").length,
        quote: content.trimEnd(),
      },
    ],
  };
  await writeFile(
    path.join(root, ".checktrail/context.json"),
    JSON.stringify(context),
  );
  return { root, context, target };
}
export function response(
  assignment: ReviewWorkflowAssignment,
  candidates: ReviewCandidate[] = [],
): ReviewWorkflowResponse {
  return {
    assignmentId: assignment.assignmentId,
    assignmentDigest: assignment.assignmentDigest,
    host: {
      client: "original-any-ai-host",
      clientVersion: "fixture-1",
      provider: "operator-chosen-provider",
      model: "fictional-exact-model",
      sessionId: randomUUID(),
      session: "fresh",
    },
    status: "completed",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    output: {
      files: [
        {
          path: "subject.mjs",
          disposition: "reviewed",
          note: "Declared scope",
        },
      ],
      candidates,
    },
  };
}
