import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { encodeReviewEvaluationArtifact } from "../src/review-evaluation-artifacts.js";
import {
  freezeReviewEvaluationCommonDefects,
  prepareReviewEvaluationMatching,
  reviewEvaluationMatchingPacket,
} from "../src/review-evaluation-matching.js";
import { sealReviewEvaluationJudgments } from "../src/review-evaluation-judging.js";
import { judgingFixture } from "./review-evaluation-judging-fixture.js";
import { protocolHex } from "./review-evaluation-protocol-fixture.js";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function matchingFixture(
  t: TestContext,
  options: {
    review?: unknown;
    unresolvedLabel?: boolean;
    judge?: (
      slot: { role: string; caseId: string; repetition: number },
      response: Record<string, unknown>,
    ) => void;
    missingJudgment?: boolean;
  } = {},
) {
  let inventory:
    ReturnType<typeof freezeReviewEvaluationCommonDefects> | undefined;
  const f = await judgingFixture(t, {
    ...(options.review !== undefined ? { review: options.review } : {}),
    beforeSeal: async (f, store) => {
      inventory = freezeReviewEvaluationCommonDefects(
        path.join(path.dirname(store), "project"),
        store,
        f.input.declaration,
        f.input.expectedProtocolSha256,
        {
          schemaVersion: 1,
          profile: "prospective-common-defect-inventory-v1",
          protocolSha256: f.input.expectedProtocolSha256,
          cases: f.input.declaration.cohort.cases.map((c, i) => ({
            caseId: c.id,
            label: options.unresolvedLabel && i === 0 ? "unresolved" : "defect",
            defects:
              options.unresolvedLabel && i === 0
                ? []
                : [
                    {
                      id: "defect-" + protocolHex(i + 1),
                      family: "types-numeric-semantics",
                      material: true,
                      description:
                        "OriginalCommonDefectAnswerCanary boundary excludes an admitted numeric value.",
                    },
                  ],
          })),
        },
      );
    },
  });
  const book = JSON.parse(
    await readFile(path.join(f.store, "judging.book.json"), "utf8"),
  );
  const judgments = [];
  for (const slot of book.slots)
    judgments.push(
      await f.response(slot.blindId, (v) => options.judge?.(slot, v)),
    );
  if (options.missingJudgment) judgments.shift();
  const sealedJudgments = sealReviewEvaluationJudgments(
      f.project,
      f.store,
      f.book.bookSha256,
      judgments,
    ),
    matching = prepareReviewEvaluationMatching(
      f.project,
      f.store,
      sealedJudgments.judgmentsSha256,
      inventory!.inventorySha256,
    );
  let session = 80000;
  const response = async (
    id: string,
    adjust?: (v: Record<string, unknown>) => void,
  ) => {
    const packet = reviewEvaluationMatchingPacket(
        f.project,
        f.store,
        matching.bookSha256,
        id,
        true,
      ),
      value: Record<string, unknown> = {
        schemaVersion: 1,
        profile: "independent-common-defect-mapping-v1",
        packetSha256: packet.packetSha256,
        sessionId: "session-" + protocolHex(session++),
        status: "completed",
        mappings: packet.reviews.flatMap((r) =>
          r.claims.map((c) => ({
            reviewId: r.reviewId,
            claimId: c.id,
            defectId:
              packet.defects.find((d) => d.family === c.family)?.id ?? null,
          })),
        ),
      };
    adjust?.(value);
    const bytes = encodeReviewEvaluationArtifact(value),
      sha256 = digest(bytes);
    await writeFile(path.join(f.store, "blobs", sha256 + ".blob"), bytes, {
      mode: 0o600,
    });
    return { blindId: id, responseSha256: sha256 };
  };
  return {
    ...f,
    inventory: inventory!,
    sealedJudgments,
    matching,
    mappingResponse: response,
  };
}
