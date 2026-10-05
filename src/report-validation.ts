import { rustExecutionId } from "./rust-build.js";
import { goTargetPreflight } from "./go-target.js";
import { goExecutionGroup, goExecutionId } from "./go-build.js";
import { reportSchema } from "./schemas.js";
export function validatedReport(input: unknown) {
  const report = reportSchema.parse(input);
  const expected = report.checks.some((check) => check.status === "failed")
    ? "failed"
    : report.sourceChanged ||
        report.sourceError ||
        !report.checks.length ||
        report.checks.some((check) => check.status !== "passed")
      ? "incomplete"
      : "passed";
  if (report.outcome !== expected)
    throw new Error("Report outcome contradicts its check evidence");
  if (
    (!report.finalSourceFingerprint && !report.sourceError) ||
    (report.finalSourceFingerprint !== null &&
      report.finalSourceFingerprint !== report.sourceFingerprint &&
      !report.sourceChanged)
  )
    throw new Error("Report source flags contradict its fingerprints");
  const checks = new Set<string>();
  const groups = new Map<string, Set<number>>();
  for (const check of report.checks) {
    const repetition = check.goBuild?.repetition;
    if (check.rustBuild) {
      if (
        check.adapter !== "rust" ||
        !["rust.cargo-check", "rust.cargo-clippy", "rust.cargo-test"].includes(
          check.id,
        ) ||
        check.goScope ||
        check.goBuild ||
        check.executionId !== rustExecutionId(check)
      )
        throw Error("Invalid Rust execution identity in report");
    } else if (repetition) {
      if (
        check.adapter !== "go" ||
        !check.goScope ||
        repetition.iteration > repetition.total ||
        check.executionId !== goExecutionId(check)
      )
        throw new Error("Invalid Go execution identity in report");
      const group = goExecutionGroup(check);
      const iterations = groups.get(group) ?? new Set<number>();
      iterations.add(repetition.iteration);
      groups.set(group, iterations);
    } else if (check.executionId || check.goBuild?.target)
      throw new Error("Go execution identity requires repetition metadata");
    if (check.goBuild?.target) {
      const target = goTargetPreflight(
        {
          goBuild: check.goBuild,
          kind:
            check.id === "go.test" || check.id === "go.test-race"
              ? "test"
              : "analysis",
        },
        check.processes,
      );
      if (
        (check.goTarget &&
          JSON.stringify(check.goTarget) !== JSON.stringify(target.evidence)) ||
        ((check.status === "passed" || check.status === "failed") &&
          (target.status !== "ready" || !check.goTarget))
      )
        throw new Error("Report contradicts its native Go target evidence");
    } else if (check.goTarget)
      throw new Error("Native Go target evidence has no declared target");
    const id = JSON.stringify([
      check.project,
      check.id,
      check.executionId ?? null,
    ]);
    if (checks.has(id)) throw new Error("Duplicate check identity in report");
    checks.add(id);
  }
  for (const check of report.checks) {
    if (
      check.goBuild?.repetition &&
      groups.get(goExecutionGroup(check))?.size !==
        check.goBuild.repetition.total
    )
      throw new Error("Required Go repetitions are missing from report");
  }
  const required = report.requiredExecutionIds ?? [];
  const actual = report.checks.flatMap((check) =>
    check.executionId ? [check.executionId] : [],
  );
  const requiredSet = new Set(required);
  if (
    requiredSet.size !== required.length ||
    required.length !== actual.length ||
    actual.some((id) => !requiredSet.has(id))
  )
    throw new Error(
      "Required execution manifest does not reconcile with report results",
    );
  return report;
}
