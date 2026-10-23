import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  encodeReviewEvaluationArtifact,
  sealReviewEvaluationCaptures,
} from "../src/review-evaluation-artifacts.js";
import {
  prepareReviewEvaluationJudging,
  reviewEvaluationJudgmentPacket,
} from "../src/review-evaluation-judging.js";
import { artifactFixture } from "./review-evaluation-artifacts-fixture.js";
import { rebindCaptures } from "./review-evaluation-captures-fixture.js";
import {
  bindProtocolCohort,
  protocolHex,
} from "./review-evaluation-protocol-fixture.js";
import { fixture } from "./helpers.js";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const originalCitation = {
  file: "src/decision.ts",
  startLine: 1,
  endLine: 1,
  quote: "return value > 4",
};
export async function judgingFixture(
  t: TestContext,
  options: {
    review?: unknown;
    source?: string;
    sourcePadding?: number;
    beforePrepare?: (store: string) => void;
    beforeSeal?: (
      f: Awaited<ReturnType<typeof artifactFixture>>,
      store: string,
    ) => Promise<void>;
  } = {},
) {
  const root = await fixture(t, {
    "project/original-marker": "Original independent judging project",
  });
  const project = path.join(root, "project"),
    store = path.join(root, "private-judging");
  await mkdir(store, { mode: 0o700 });
  const sources: { caseId: string; base64: string }[] = [];
  const review = options.review ?? {
    schemaVersion: 1,
    profile: "independent-review-output-v1",
    claims: [
      {
        id: "claim-" + protocolHex(1),
        family: "types-numeric-semantics",
        statement: "Original predicate excludes the boundary value.",
        citations: [structuredClone(originalCitation)],
        probability: 0.8,
      },
    ],
  };
  const f = await artifactFixture(store, undefined, (input) => {
    for (const [c, row] of input.declaration.cohort.cases.entries()) {
      const packet = {
        schemaVersion: 1,
        profile: "independent-review-source-packet-v1",
        files: [
          {
            file: "src/decision.ts",
            content:
              (options.source ??
                "export function permits(value: number) { return value > 4; }") +
              " // Original fixture " +
              (c + 1) +
              "\n" +
              " ".repeat(options.sourcePadding ?? 0),
          },
        ],
      };
      const bytes = encodeReviewEvaluationArtifact(packet);
      row.contentSha256 = digest(bytes);
      sources.push({ caseId: row.id, base64: bytes.toString("base64") });
    }
    bindProtocolCohort(input.declaration);
    rebindCaptures(input);
    const bytes = encodeReviewEvaluationArtifact(review);
    for (const slot of input.metering.slots)
      for (const attempt of slot.attempts) attempt.outputBytes = bytes.length;
    return bytes;
  });
  await options.beforeSeal?.(f, store);
  const captured = sealReviewEvaluationCaptures(project, store, f.input);
  options.beforePrepare?.(store);
  const book = prepareReviewEvaluationJudging(
    project,
    store,
    captured.archiveSha256,
    sources,
  );
  let session = 50000;
  const response = async (
    id: string,
    adjust?: (value: Record<string, unknown>) => void,
  ) => {
    const packet = reviewEvaluationJudgmentPacket(
      project,
      store,
      book.bookSha256,
      id,
      true,
    );
    const value: Record<string, unknown> = {
      schemaVersion: 1,
      profile: "independent-review-judgment-v1",
      packetSha256: packet.packetSha256,
      sessionId: "session-" + protocolHex(session++),
      status: "completed",
      claims: packet.claims.map((c) => ({
        id: c.id,
        judgement: "supported",
        citations: [structuredClone(originalCitation)],
      })),
    };
    adjust?.(value);
    const bytes = encodeReviewEvaluationArtifact(value),
      sha256 = digest(bytes);
    await writeFile(path.join(store, "blobs", sha256 + ".blob"), bytes, {
      mode: 0o600,
    });
    return { blindId: id, responseSha256: sha256 };
  };
  return { project, store, ...f, sources, captured, book, response };
}
