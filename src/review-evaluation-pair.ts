import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { reviewEvaluationProtocolSchema } from "./review-evaluation-protocol.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const treatment = z.discriminatedUnion("checktrailEnabled", [
  z.strictObject({ checktrailEnabled: z.literal(false) }),
  z.strictObject({
    checktrailEnabled: z.literal(true),
    engineArtifactsSha256: digest,
    usageInstructionsSha256: digest,
  }),
]);

/** Prospective settings only; these declarations do not attest an actual host. */
export const reviewEvaluationArmConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal("prospective-review-arm-configuration-v1"),
  role: z.enum(["priorWorkflow", "verifier"]),
  host: z.strictObject({
    client: z.enum(["codex", "claude-code"]),
    clientVersion: name,
    executableSha256: digest,
    requestedModel: name,
    reasoningEffort: name.nullable(),
    settingsSha256: digest,
  }),
  context: z.strictObject({
    taskSha256: digest,
    repositoryInstructionsSha256: digest,
  }),
  native: z.strictObject({ toolsSha256: digest, environmentSha256: digest }),
  budgets: reviewEvaluationProtocolSchema.shape.budgets,
  isolation: z.strictObject({
    session: z.literal("fresh-per-arm"),
    sharedHistory: z.literal(false),
    sharedOutputs: z.literal(false),
  }),
  treatment,
});
export type ReviewEvaluationArmConfiguration = z.infer<
  typeof reviewEvaluationArmConfigurationSchema
>;
export const reviewEvaluationPairInputSchema = z.strictObject({
  protocol: reviewEvaluationProtocolSchema,
  configurations: z.strictObject({
    priorWorkflow: z.string().max(1048576),
    verifier: z.string().max(1048576),
  }),
});
type Issue =
  | "protocol-binding"
  | "baseline-kind"
  | "baseline-digest"
  | "verifier-digest"
  | "baseline-configuration"
  | "verifier-configuration"
  | "host-mismatch"
  | "context-mismatch"
  | "native-mismatch"
  | "budgets-mismatch"
  | "native-binding"
  | "budget-binding"
  | "engine-binding";

/** No files, host sessions, case source or services are opened by this check. */
export function inspectReviewEvaluationPair(
  input: unknown,
  expectedProtocolSha256: string,
) {
  const parsed = reviewEvaluationPairInputSchema.parse(input);
  const { protocol, configurations } = parsed;
  const expected = digest.parse(expectedProtocolSha256);
  const protocolSha256 = sha(JSON.stringify(protocol));
  const issues: Issue[] = [];
  if (protocolSha256 !== expected) issues.push("protocol-binding");
  if (protocol.priorWorkflow.kind !== "declared-comparison-baseline")
    issues.push("baseline-kind");
  const configurationSha256 = {
    priorWorkflow: sha(configurations.priorWorkflow),
    verifier: sha(configurations.verifier),
  };
  if (
    configurationSha256.priorWorkflow !==
    protocol.priorWorkflow.configurationSha256
  )
    issues.push("baseline-digest");
  if (configurationSha256.verifier !== protocol.verifierConfigurationSha256)
    issues.push("verifier-digest");
  const decode = (text: string) => {
    try {
      if (Buffer.byteLength(text) > 1048576) return null;
      return reviewEvaluationArmConfigurationSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  };
  const baseline = decode(configurations.priorWorkflow);
  const verifier = decode(configurations.verifier);
  if (
    !baseline ||
    baseline.role !== "priorWorkflow" ||
    baseline.treatment.checktrailEnabled
  )
    issues.push("baseline-configuration");
  if (
    !verifier ||
    verifier.role !== "verifier" ||
    !verifier.treatment.checktrailEnabled
  )
    issues.push("verifier-configuration");
  if (baseline && verifier) {
    for (const [field, issue] of [
      ["host", "host-mismatch"],
      ["context", "context-mismatch"],
      ["native", "native-mismatch"],
      ["budgets", "budgets-mismatch"],
    ] as const) {
      if (!isDeepStrictEqual(baseline[field], verifier[field]))
        issues.push(issue);
    }
    if (
      [baseline, verifier].some(
        (arm) =>
          arm.native.toolsSha256 !==
            protocol.implementation.nativeToolsSha256 ||
          arm.native.environmentSha256 !==
            protocol.implementation.environmentSha256,
      )
    )
      issues.push("native-binding");
    if (
      [baseline, verifier].some(
        (arm) => !isDeepStrictEqual(arm.budgets, protocol.budgets),
      )
    )
      issues.push("budget-binding");
    if (
      verifier.treatment.checktrailEnabled &&
      verifier.treatment.engineArtifactsSha256 !==
        protocol.implementation.engineArtifactsSha256
    )
      issues.push("engine-binding");
  }
  return {
    schemaVersion: 1 as const,
    profile: "prospective-review-pair-settings-v1" as const,
    protocolSha256,
    configurationSha256,
    declaredSettingsMatched: issues.length === 0,
    issues,
    effectiveHostConfigurationVerified: false as const,
    modelAvailabilityVerified: false as const,
    hostIndependenceVerified: false as const,
    nativeToolchainsVerified: false as const,
    cohortReadinessVerified: false as const,
    protocolFrozen: false as const,
    gateAClosed: false as const,
    qualityAssessed: false as const,
    inferenceExecuted: false as const,
    fieldEvaluationExecuted: false as const,
    privateIdentitiesIncluded: false as const,
  };
}
export type ReviewEvaluationPairReport = ReturnType<
  typeof inspectReviewEvaluationPair
>;
