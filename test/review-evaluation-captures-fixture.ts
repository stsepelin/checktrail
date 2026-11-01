import { createHash } from "node:crypto";
import {
  reviewEvaluationCaptureAssignments,
  type ReviewEvaluationCaptureInput,
} from "../src/review-evaluation-captures.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import { meteringFixture } from "./review-evaluation-metering-fixture.js";
import { protocolSha } from "./review-evaluation-protocol-fixture.js";
const address = (r: { caseId: string; repetition: number; role: string }) =>
  JSON.stringify([r.caseId, r.repetition, r.role]);
export function captureFixture(total = 3): ReviewEvaluationCaptureInput {
  const meter = meteringFixture(total);
  const assignments = new Map(
    reviewEvaluationCaptureAssignments(meter.declaration).map((a) => [
      address(a),
      a,
    ]),
  );
  const text = "Original externally supplied independent review text.";
  return {
    ...meter,
    captures: meter.metering.slots.map((slot, i) => {
      const a = assignments.get(address(slot))!;
      return {
        caseId: a.caseId,
        repetition: a.repetition,
        role: a.role,
        assignmentSha256: a.assignmentSha256,
        configurationSha256: a.configurationSha256,
        sourceArchiveSha256: a.sourceArchiveSha256,
        contentSha256: a.contentSha256,
        captureSha256: protocolSha(20000 + i),
        status: slot.status,
        attemptRecords: slot.attempts.map((a) => a.recordSha256),
        output: {
          sha256: createHash("sha256").update(text).digest("hex"),
          bytes: Buffer.byteLength(text),
        },
      };
    }),
  };
}
export function rebindCaptures(input: ReviewEvaluationCaptureInput) {
  const p = inspectReviewEvaluationProtocol(input.declaration);
  input.expectedProtocolSha256 = p.protocolSha256;
  input.metering.protocolSha256 = p.protocolSha256;
  input.metering.procedureSha256 =
    input.declaration.protocol.procedures.externalMeteringSha256;
  const assignments = new Map(
    reviewEvaluationCaptureAssignments(input.declaration).map((a) => [
      address(a),
      a,
    ]),
  );
  for (const row of input.captures) {
    const a = assignments.get(address(row))!;
    row.assignmentSha256 = a.assignmentSha256;
    row.configurationSha256 = a.configurationSha256;
    row.sourceArchiveSha256 = a.sourceArchiveSha256;
    row.contentSha256 = a.contentSha256;
  }
  return input;
}
