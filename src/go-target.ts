import { z } from "zod";
import { goTargetEvidenceSchema, type GoTargetEvidence } from "./go-build.js";
import type { Check, ProcessResult } from "./types.js";

const environment = z.strictObject({
  GOOS: z.string(),
  GOARCH: z.string(),
  GOHOSTOS: z.string(),
  GOHOSTARCH: z.string(),
  CGO_ENABLED: z.enum(["0", "1"]),
});
const targets = z
  .array(
    z.strictObject({
      GOOS: z.string(),
      GOARCH: z.string(),
      CgoSupported: z.boolean(),
      FirstClass: z.boolean(),
    }),
  )
  .min(1)
  .max(256);
type NativeResult = Pick<
  ProcessResult,
  | "exitCode"
  | "signal"
  | "stdout"
  | "stderr"
  | "timedOut"
  | "cancelled"
  | "truncated"
> & { errorCode?: string | undefined };
const complete = (result: NativeResult | undefined) =>
  result &&
  result.exitCode === 0 &&
  result.signal === null &&
  !result.stderr.trim() &&
  !result.timedOut &&
  !result.cancelled &&
  !result.truncated &&
  !result.errorCode;

export function goTargetPreflight(
  check: Pick<Check, "goBuild" | "kind">,
  processes: NativeResult[],
): {
  status: "ready" | "unavailable" | "inconclusive";
  reason: string;
  evidence?: GoTargetEvidence;
} {
  const desired = check.goBuild?.target;
  if (!desired || !complete(processes[0]) || !complete(processes[1]))
    return {
      status: "inconclusive",
      reason: "Native Go target evidence did not complete.",
    };
  try {
    const native = environment.parse(JSON.parse(processes[0]!.stdout));
    const supported = targets.parse(JSON.parse(processes[1]!.stdout));
    const seen = new Set<string>();
    for (const item of supported) {
      const key = JSON.stringify([item.GOOS, item.GOARCH]);
      if (seen.has(key)) throw new Error("Duplicate native target");
      seen.add(key);
    }
    const evidence = goTargetEvidenceSchema.parse({
      os: native.GOOS,
      arch: native.GOARCH,
      cgo: native.CGO_ENABLED === "1",
      hostOs: native.GOHOSTOS,
      hostArch: native.GOHOSTARCH,
    });
    if (
      evidence.os !== desired.os ||
      evidence.arch !== desired.arch ||
      evidence.cgo !== desired.cgo
    )
      return {
        status: "inconclusive",
        reason: "Native Go target does not match the planned target.",
        evidence,
      };
    const target = supported.find(
      (item) => item.GOOS === evidence.os && item.GOARCH === evidence.arch,
    );
    if (!target || (evidence.cgo && !target.CgoSupported))
      return {
        status: "unavailable",
        reason:
          "The installed Go toolchain does not support the required target or cgo mode.",
        evidence,
      };
    if (
      check.kind === "test" &&
      (evidence.os !== evidence.hostOs || evidence.arch !== evidence.hostArch)
    )
      return {
        status: "unavailable",
        reason:
          "Required Go tests target another platform; no target executor is configured.",
        evidence,
      };
    return {
      status: "ready",
      reason: "Native Go target matches the required profile.",
      evidence,
    };
  } catch {
    return {
      status: "inconclusive",
      reason: "Native Go target evidence is malformed or ambiguous.",
    };
  }
}
