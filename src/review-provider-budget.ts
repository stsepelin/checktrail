import { isDeepStrictEqual } from "node:util";
import type {
  ReviewProviderConfig,
  ReviewProviderRun,
  ReviewProviderBudget,
} from "./review-provider-schema.js";

type Rates = ReviewProviderBudget["operatorRates"];
type Attempt = ReviewProviderRun["attempts"][number];

// Decimal rates and integer microdollars avoid floating-point admission drift.
// JavaScript's canonical decimal spelling is the operator's retained rate value.
function decimal(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [integer, fractional = ""] = mantissa!.split(".");
  const power = Number(exponent) - fractional.length;
  const digits = BigInt(integer! + fractional);
  return power >= 0
    ? { numerator: digits * 10n ** BigInt(power), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(-power) };
}
export function providerUsageCostMicrousd(
  input: number,
  output: number,
  rates: Rates,
): number | null {
  if (!rates) return null;
  const a = decimal(rates.inputUSDPerMillion);
  const b = decimal(rates.outputUSDPerMillion);
  // Dollars per million tokens equal microdollars per token.
  const numerator =
    BigInt(input) * a.numerator * b.denominator +
    BigInt(output) * b.numerator * a.denominator;
  const denominator = a.denominator * b.denominator;
  const rounded = (numerator + denominator - 1n) / denominator;
  return rounded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rounded) : null;
}
function total(
  attempts: Attempt[],
  key: "inputTokens" | "outputTokens",
): number | null {
  if (!attempts.length || attempts.some((a) => a.usage[key] === null))
    return null;
  const value = attempts.reduce((sum, a) => sum + a.usage[key]!, 0);
  return Number.isSafeInteger(value) ? value : null;
}

/** Reconstructed from configured allowances and reported usage; never a billing guarantee. */
export function providerBudget(
  limits: ReviewProviderConfig["limits"],
  attempts: Attempt[],
  operatorRates: Rates,
): ReviewProviderBudget | undefined {
  const budget = limits.admissionBudget;
  if (!budget) return undefined;
  const input = total(attempts, "inputTokens");
  const output = total(attempts, "outputTokens");
  const observedTokens =
    input !== null && output !== null && Number.isSafeInteger(input + output)
      ? input + output
      : null;
  const observedMicrousd =
    input !== null && output !== null
      ? providerUsageCostMicrousd(input, output, operatorRates)
      : null;
  const reservationTokens = budget.inputTokenAllowance + limits.maxOutputTokens;
  const reservationMicrousd = providerUsageCostMicrousd(
    budget.inputTokenAllowance,
    limits.maxOutputTokens,
    operatorRates,
  );
  let decision: ReviewProviderBudget["decision"] = "within-budget";
  if (budget.maxEstimatedCostMicrousd !== null && !operatorRates)
    decision = "pricing-unavailable";
  else if (
    attempts.some(
      (a) =>
        a.usage.inputTokens !== null &&
        a.usage.inputTokens > budget.inputTokenAllowance,
    )
  )
    decision = "input-allowance-exceeded";
  else if (attempts.length && observedTokens === null)
    decision = "usage-unknown";
  else if (observedTokens !== null && observedTokens > budget.maxTotalTokens)
    decision = "token-limit-exceeded";
  else if (
    budget.maxEstimatedCostMicrousd !== null &&
    attempts.length &&
    observedMicrousd === null
  )
    decision = "usage-unknown";
  else if (
    budget.maxEstimatedCostMicrousd !== null &&
    observedMicrousd !== null &&
    observedMicrousd > budget.maxEstimatedCostMicrousd
  )
    decision = "cost-limit-exceeded";
  else if (
    attempts.some(
      (a) =>
        a.usage.outputTokens !== null &&
        a.usage.outputTokens > limits.maxOutputTokens,
    )
  )
    decision = "output-allowance-exceeded";
  else {
    // A next disclosure is requested only at startup or after a retryable error.
    const needsNext =
      !attempts.length ||
      (attempts.length < limits.maxAttempts &&
        ["capacity", "rate-limited", "unavailable"].includes(
          attempts.at(-1)!.status,
        ));
    if (
      needsNext &&
      ((observedTokens ?? 0) + reservationTokens > budget.maxTotalTokens ||
        (budget.maxEstimatedCostMicrousd !== null &&
          (reservationMicrousd === null ||
            (observedMicrousd ?? 0) + reservationMicrousd >
              budget.maxEstimatedCostMicrousd)))
    )
      decision = "reservation-does-not-fit";
  }
  return {
    profile: "reported-usage-admission-v1",
    operatorRates,
    reservationTokens,
    reservationMicrousd,
    observedTokens,
    observedMicrousd,
    decision,
    inputAllowanceVerified: false,
    billingCeilingGuaranteed: false,
  };
}

export function checkProviderBudget(run: ReviewProviderRun): void {
  for (let index = 0; index < run.attempts.length; index++) {
    const previous = run.attempts.slice(0, index);
    const admission = providerBudget(
      run.limits,
      previous,
      run.budget?.operatorRates ?? null,
    );
    if (
      admission &&
      (admission.decision !== "within-budget" ||
        (index > 0 &&
          !["capacity", "rate-limited", "unavailable"].includes(
            previous.at(-1)!.status,
          )))
    )
      throw new Error("Provider attempt was not admitted by its budget");
  }
  const expected = providerBudget(
    run.limits,
    run.attempts,
    run.budget?.operatorRates ?? null,
  );
  if (!isDeepStrictEqual(expected, run.budget))
    throw new Error("Provider admission budget does not reconcile");
  if (
    expected &&
    expected.decision !== "within-budget" &&
    !["budget-exhausted", "stale", "timed-out", "cancelled"].includes(
      run.status,
    )
  )
    throw new Error(
      "Unmeasurable or exceeded admission budget cannot complete a review",
    );
}
