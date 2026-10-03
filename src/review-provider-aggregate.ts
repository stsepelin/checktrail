import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { providerBudget } from "./review-provider-budget.js";
import type {
  ReviewProviderConfig,
  ReviewProviderRun,
} from "./review-provider-schema.js";

type Attempt = ReviewProviderRun["attempts"][number];
type Aggregate = NonNullable<ReviewProviderRun["aggregateBudget"]>;
type Session = {
  id: string;
  config: ReviewProviderConfig;
  attempts: Attempt[];
};
// Accounting lives only in the engine. It is never a model message or MCP argument.
const shared = new WeakMap<object, Session>();
export function shareProviderRunBudget(
  options: object,
  config: ReviewProviderConfig,
): void {
  if (config.limits.aggregateBudget)
    shared.set(options, {
      id: randomUUID(),
      config: structuredClone(config),
      attempts: [],
    });
}
export function assignmentProviderBudget(
  options: object,
  config: ReviewProviderConfig,
): Session | undefined {
  if (!config.limits.aggregateBudget) return undefined;
  const session = shared.get(options) ?? {
    id: randomUUID(),
    config: structuredClone(config),
    attempts: [],
  };
  if (!isDeepStrictEqual(session.config, config))
    throw new Error("Shared provider budget configuration changed");
  return session;
}
const retryable = (attempt: Attempt): boolean =>
  ["capacity", "rate-limited", "unavailable"].includes(attempt.status);
export function aggregateProviderBudget(
  limits: ReviewProviderConfig["limits"],
  attempts: Attempt[],
  priorAttempts: Attempt[],
  id: string,
  requestBytes: number,
  operatorRates: Aggregate["operatorRates"],
): Aggregate | undefined {
  const cap = limits.aggregateBudget;
  if (!cap) return undefined;
  const all = [...priorAttempts, ...attempts];
  // Do not let a prior completed assignment suppress admission of the next one.
  const needsNext =
    !attempts.length ||
    (attempts.length < limits.maxAttempts && retryable(attempts.at(-1)!));
  const observed = providerBudget(
    { ...limits, admissionBudget: cap, maxAttempts: 1 },
    all,
    operatorRates,
  )!;
  const requestTotal = all.reduce(
    (sum, item) => sum + (item.requestBytes ?? 0),
    0,
  );
  const responseTotal = all.reduce((sum, item) => sum + item.responseBytes, 0);
  let decision: Aggregate["decision"] = observed.decision;
  if (decision === "within-budget") {
    if (all.length > cap.maxCalls || (needsNext && all.length >= cap.maxCalls))
      decision = "call-limit-exceeded";
    else if (
      requestTotal > cap.maxRequestBodyBytes ||
      (needsNext && requestTotal + requestBytes > cap.maxRequestBodyBytes)
    )
      decision = "request-byte-limit-exceeded";
    else if (responseTotal > cap.maxResponseBodyBytes)
      decision = "response-byte-limit-exceeded";
    else if (
      needsNext &&
      responseTotal + limits.maxResponseBytes > cap.maxResponseBodyBytes
    )
      decision = "response-reservation-does-not-fit";
    else if (
      needsNext &&
      ((observed.observedTokens ?? 0) + observed.reservationTokens >
        cap.maxTotalTokens ||
        (cap.maxEstimatedCostMicrousd !== null &&
          (observed.reservationMicrousd === null ||
            (observed.observedMicrousd ?? 0) + observed.reservationMicrousd >
              cap.maxEstimatedCostMicrousd)))
    )
      decision = "reservation-does-not-fit";
  }
  return {
    ...observed,
    profile: "reported-usage-run-admission-v1",
    id,
    priorAttempts: structuredClone(priorAttempts),
    requestBytes,
    observedCalls: all.length,
    observedRequestBodyBytes: requestTotal,
    observedResponseBodyBytes: responseTotal,
    decision,
    transportByteCeilingGuaranteed: false,
  };
}
export function checkAggregateProviderBudget(run: ReviewProviderRun): void {
  const cap = run.limits.aggregateBudget;
  const receipt = run.aggregateBudget;
  if (Boolean(cap) !== Boolean(receipt))
    throw new Error("Provider aggregate budget is missing or unconfigured");
  if (!receipt) return;
  const all = [...receipt.priorAttempts, ...run.attempts];
  if (
    new Set(all.map((item) => item.id)).size !== all.length ||
    all.some(
      (item) =>
        item.requestBytes === undefined ||
        item.requestBytes > run.limits.maxRequestBytes,
    ) ||
    run.attempts.some((item) => item.requestBytes !== receipt.requestBytes)
  )
    throw new Error(
      "Provider aggregate attempt body accounting does not reconcile",
    );
  for (let index = 0; index < all.length; index++) {
    const prefix = all.slice(0, index);
    const admission = aggregateProviderBudget(
      run.limits,
      [],
      prefix,
      receipt.id,
      all[index]!.requestBytes!,
      receipt.operatorRates,
    )!;
    if (admission.decision !== "within-budget")
      throw new Error("Provider aggregate attempt was not admitted");
  }
  const expected = aggregateProviderBudget(
    run.limits,
    run.attempts,
    receipt.priorAttempts,
    receipt.id,
    receipt.requestBytes,
    receipt.operatorRates,
  );
  if (
    !isDeepStrictEqual(receipt, expected) ||
    (run.budget &&
      !isDeepStrictEqual(run.budget.operatorRates, receipt.operatorRates))
  )
    throw new Error("Provider aggregate budget does not reconcile");
  if (
    receipt.decision !== "within-budget" &&
    !["budget-exhausted", "stale", "timed-out", "cancelled"].includes(
      run.status,
    )
  )
    throw new Error(
      "Unmeasurable or exceeded aggregate budget cannot complete a review",
    );
}
