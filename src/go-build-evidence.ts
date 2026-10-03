import { goCompileFindings } from "./go-compile-evidence.js";
import { goScopeComplete } from "./go-scope.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";

export function goBuildEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  if (!root || !goScopeComplete(check, processes[0], root))
    return {
      status: "inconclusive",
      reason:
        "Native production Go selection or declared exclusions did not reconcile.",
    };
  const native = processes[1]!;
  if (native.exitCode === 0) {
    if (native.stdout.trim() || native.stderr.trim())
      return {
        status: "inconclusive",
        reason: "Successful Go build returned unexpected output.",
      };
    return {
      status: "passed",
      reason:
        "Native Go built the selected production packages; no tests were executed.",
    };
  }
  if (native.stdout.trim())
    return {
      status: "error",
      reason:
        "Go build failed with unsupported output; no complete source failure was established.",
    };
  const blocks = native.stderr.trimEnd().split(/(?=^# )/m);
  const parsed = blocks.map((block) =>
    goCompileFindings(check, root, block, "go.compiler"),
  );
  if (!parsed.length || parsed.some((findings) => !findings?.length))
    return {
      status: "error",
      reason:
        "Go build did not complete with fully positioned compiler diagnostics; loading, linking or toolchain failure remains incomplete.",
    };
  return {
    status: "failed",
    reason:
      "Native Go compiler reported positioned production source diagnostics.",
    findings: parsed.flatMap((findings) => findings!),
    findingsComplete: true,
  };
}
