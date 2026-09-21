import path from "node:path";
import { validatedReport } from "./report-validation.js";

function uri(file: string): string {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    file.includes("\\") ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "SARIF requires normalized repository-relative finding paths",
    );
  return file.split("/").map(encodeURIComponent).join("/");
}
const message = (text: string) => ({ text: text.replace(/[{}]/g, "$&$&") });

export function exportSarif(input: unknown) {
  const report = validatedReport(input);
  const checks: ((typeof report.checks)[number] | undefined)[] = report.checks
    .length
    ? report.checks
    : [undefined];
  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cos02/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: checks.map((check) => {
      const findings = check?.findings ?? [];
      const ruleIds = [...new Set(findings.map((finding) => finding.ruleId))];
      const ruleId = (nativeId: string) =>
        `${encodeURIComponent(check!.id)}/${encodeURIComponent(nativeId)}`;
      const complete = Boolean(
        check &&
        !report.sourceChanged &&
        !report.sourceError &&
        (check.status === "passed" ||
          (check.status === "failed" &&
            check.findingsComplete === true &&
            findings.length > 0)),
      );
      const notification = !check
        ? "No checks were executed."
        : report.sourceChanged || report.sourceError
          ? "Source changed or could not be verified after execution; findings are not current-source validation."
          : check.status === "failed" && findings.length === 0
            ? "The check failed without exportable source diagnostics. Consult the complete validation report."
            : check.reason;
      return {
        tool: {
          driver: {
            name: "checktrail",
            version: report.engineVersion,
            rules: ruleIds.map((id) => ({ id: ruleId(id), name: id })),
          },
        },
        invocations: [
          {
            executionSuccessful: complete,
            toolExecutionNotifications: [
              {
                level: complete ? "note" : "error",
                message: message(notification),
              },
            ],
          },
        ],
        results: findings.map((finding) => ({
          ruleId: ruleId(finding.ruleId),
          ruleIndex: ruleIds.indexOf(finding.ruleId),
          level: finding.level,
          message: message(finding.message),
          ...(finding.file
            ? {
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {
                        uri: uri(finding.file),
                        uriBaseId: "%SRCROOT%",
                      },
                      ...(finding.line
                        ? { region: { startLine: finding.line } }
                        : {}),
                    },
                  },
                ],
              }
            : {}),
        })),
        properties: {
          runId: report.runId,
          ...(report.selection ? { selection: report.selection } : {}),
          outcome: report.outcome,
          sourceFingerprint: report.sourceFingerprint,
          finalSourceFingerprint: report.finalSourceFingerprint,
          policyFingerprint: report.policyFingerprint,
          sourceChanged: report.sourceChanged,
          sourceError: report.sourceError,
          ...(check
            ? {
                checkId: check.id,
                project: check.project,
                status: check.status,
                normalizedFindingsAvailable: check.findings !== undefined,
                ...(check.tests ? { tests: check.tests } : {}),
                ...(check.environment
                  ? { environment: check.environment }
                  : {}),
                tools:
                  check.tools?.map(({ name, version, status, source }) => ({
                    name,
                    version,
                    status,
                    source,
                  })) ?? [],
              }
            : {}),
        },
      };
    }),
  };
}
