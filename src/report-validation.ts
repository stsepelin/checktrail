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
  for (const check of report.checks) {
    const id = JSON.stringify([check.project, check.id]);
    if (checks.has(id)) throw new Error("Duplicate check identity in report");
    checks.add(id);
  }
  return report;
}
