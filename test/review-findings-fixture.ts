import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { provenanceFixture } from "./confidence-provenance-fixture.js";
import { source } from "./review-workflow-fixture.js";
import { reviewFindingsInputSchema } from "../src/review-findings.js";
export const findingsHash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function findingsFixture(
  t: TestContext,
  content = source,
  native = true,
) {
  const d = await provenanceFixture(t, content, native);
  d.input.scoring = null;
  if (!("analysis" in d.context)) throw Error("Captured functions required");
  const fn = d.context.analysis.functions.find(
    (f) => f.revision === "current" && f.name === "decision",
  )!;
  const input = reviewFindingsInputSchema.parse({
    schemaVersion: 1,
    profile: "source-bound-declared-findings-v1",
    provenance: d.input,
    reviewerSessionId: "OriginalReviewerSession",
    decisions: [
      {
        candidateId: d.target.id,
        contextDigest: d.context.contextDigest,
        candidateDigest: findingsHash(d.target),
        nativeRunDigest: native ? findingsHash(d.input.native[0]!.run) : null,
        nativeCaseIds: native
          ? d.input.native[0]!.run.trials.map((t) => t.id)
          : [],
        refutation: {
          state: "completed",
          sessionId: "OriginalRefuterSession",
          rationale:
            "Original declared counterexample search, not evidence of host isolation.",
        },
        adjudication: {
          state: "completed",
          sessionId: "OriginalAdjudicatorSession",
          rationale:
            "Original declared resolution, not independently established truth.",
          judgment: {
            disposition: "supported",
            citationIndex: 0,
            functionId: fn.id,
            mechanism: "The prefix admits the synthetic sibling identifier.",
            reachableCallers:
              "The synthetic export is the only declared caller boundary.",
            defaultsChecked:
              "No base class or framework default is declared for this original export.",
            consequence: {
              category: "wrong-result",
              extent: "single",
              access: "unprivileged",
              recovery: "reversible",
              statement:
                "The synthetic identifier yields the opposite pinned Boolean.",
            },
            repair: {
              citationIndex: 0,
              functionId: fn.id,
              requiredParameters: ["name"],
              scope: "this-change",
              text: "Compare the complete name parameter to the declared identifier.",
            },
          },
        },
      },
    ],
    commonDefects: [
      {
        id: "OriginalCommonDefect",
        rootFunctionId: fn.id,
        candidateIds: [d.target.id],
        rationale:
          "Original explicit common-cause declaration, not inferred semantic equality.",
      },
    ],
  });
  return { ...d, input, fn };
}
