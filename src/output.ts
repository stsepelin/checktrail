import type { Plan, Report, ChangeSelection } from "./types.js";

function selectionSummary(selection?: ChangeSelection) {
  return selection
    ? {
        selection: {
          mode: selection.mode,
          reason: selection.reason,
          projectCount: selection.selectedProjects.length,
          changedFileCount: selection.changedFiles.length,
        },
      }
    : {};
}

export function projectPlan(
  plan: Plan,
  detailed: boolean,
): Record<string, unknown> {
  if (detailed) return { ...plan };
  return {
    ...selectionSummary(plan.selection),
    schemaVersion: plan.schemaVersion,
    engineVersion: plan.engineVersion,
    projectCount: plan.projects.length,
    adapters: [...new Set(plan.projects.map((project) => project.adapter))],
    excludedCount: plan.excluded.length,
    checks: plan.checks.map((check) => ({
      id: check.id,
      ...(check.goBuild ? { goBuildTagCount: check.goBuild.tags.length } : {}),
      ...(check.goScope
        ? { goExcludedFileCount: check.goScope.excludedFiles.length }
        : {}),
      kind: check.kind,
      ready: !check.unavailableReason,
    })),
  };
}

export function projectReport(
  report: Report,
  detailed: boolean,
): Record<string, unknown> {
  if (detailed) return { ...report };
  return {
    ...selectionSummary(report.selection),
    schemaVersion: report.schemaVersion,
    engineVersion: report.engineVersion,
    runId: report.runId,
    outcome: report.outcome,
    durationMs: report.durationMs,
    sourceChanged: report.sourceChanged,
    sourceError: report.sourceError,
    checks: report.checks.map((check) => ({
      id: check.id,
      ...(check.goBuild ? { goBuildTagCount: check.goBuild.tags.length } : {}),
      ...(check.goScope
        ? { goExcludedFileCount: check.goScope.excludedFiles.length }
        : {}),
      status: check.status,
      ...(check.tests ? { tests: check.tests } : {}),
    })),
  };
}
