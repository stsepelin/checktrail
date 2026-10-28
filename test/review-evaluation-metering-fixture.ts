import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import type { ReviewEvaluationMeteringInput } from "../src/review-evaluation-metering.js";
import {
  protocolFixture,
  protocolHex,
  protocolSha,
} from "./review-evaluation-protocol-fixture.js";

export function meteringFixture(total = 3): ReviewEvaluationMeteringInput {
  const declaration = protocolFixture(total);
  const protocol = inspectReviewEvaluationProtocol(declaration);
  let index = 0;
  return {
    declaration,
    expectedProtocolSha256: protocol.protocolSha256,
    metering: {
      schemaVersion: 1,
      profile: "external-review-attempt-metering-v1",
      protocolSha256: protocol.protocolSha256,
      procedureSha256: declaration.protocol.procedures.externalMeteringSha256,
      collectorConfigurationSha256: protocolSha(9000),
      slots: protocol.schedule.flatMap((row) =>
        row.order.map((role) => ({
          caseId: row.caseId,
          repetition: row.repetition,
          role,
          status: "completed" as const,
          elapsedMs: 30,
          attempts: ["capacity", "completed"].map((status, ordinal) => ({
            ordinal,
            sessionId: "session-" + protocolHex(++index),
            status: status as "capacity" | "completed",
            recordSha256: protocolSha(index + 10000),
            source: "operator-meter" as const,
            elapsedMs: 10,
            inputTokens: 100,
            outputTokens: 20,
            toolCalls: 1,
            outputBytes: 80,
            costMicrousd: 40,
          })),
        })),
      ),
    },
  };
}
