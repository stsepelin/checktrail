import { z } from "zod";
import path from "node:path";
import {
  terraformInvocationSchema,
  terraformModules,
  terraformBinarySha256,
  terraformRequire,
} from "./terraform.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  integer = z.number().int().nonnegative(),
  text = z.string().max(1024 * 1024);
export const terraformPacketSchema = z.strictObject({
  version: z.literal(1),
  temporary: file,
  workspace: file,
  source: file,
  inputSha256: digest,
  tool: z.strictObject({
    entry: file,
    resolved: file,
    sha256: digest,
    afterSha256: digest,
  }),
  modules: z
    .array(
      z.strictObject({
        file,
        sha256: digest,
        afterSha256: digest,
        declarations: z.strictObject({
          variables: integer,
          locals: integer,
          outputs: integer,
        }),
      }),
    )
    .min(1)
    .max(32),
  cliConfig: z.strictObject({ file, sha256: digest, afterSha256: digest }),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum(["version", "validate"]),
        executable: file,
        args: z.array(file).min(1).max(16),
        exitCode: integer.max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(2),
});
const position = z.strictObject({
  line: integer.min(1),
  column: integer.min(1),
  byte: integer,
});
const diagnostic = z.strictObject({
  severity: z.enum(["error", "warning"]),
  summary: z.string().min(1).max(8192),
  detail: z.string().max(65536).optional(),
  range: z
    .strictObject({ filename: file, start: position, end: position })
    .nullable()
    .optional(),
  snippet: z
    .strictObject({
      context: z.string().nullable().optional(),
      code: z.string().max(65536),
      start_line: integer.min(1),
      highlight_start_offset: integer,
      highlight_end_offset: integer,
      values: z
        .array(z.strictObject({ traversal: z.string(), statement: z.string() }))
        .max(64),
    })
    .nullable()
    .optional(),
});
const nativeResult = z.strictObject({
  format_version: z.literal("1.0"),
  valid: z.boolean(),
  error_count: integer,
  warning_count: integer,
  diagnostics: z.array(diagnostic).max(256),
});
export function terraformEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Terraform native evidence is incomplete or inconsistent with declared module, source positions, configuration, commands or counters",
    findingsComplete: false,
  };
  try {
    terraformRequire(
      check.commands.length === 1 && processes.length === 1,
      "Process accounting differs",
    );
    const process = processes[0]!;
    terraformRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.signal &&
        !process.errorCode,
      "Native collection incomplete",
    );
    if (process.exitCode === 3) {
      z.strictObject({ unavailable: z.literal("terraform-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason:
          "Terraform is unavailable or outside the pinned Linux ARM64 profile",
        findingsComplete: false,
      };
    }
    terraformRequire(process.exitCode === 0, "Collector failed");
    const invocation = terraformInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      modules = terraformModules(invocation),
      packet = terraformPacketSchema.parse(JSON.parse(process.stdout));
    terraformRequire(
      check.id === "infrastructure.terraform-validate" &&
        JSON.stringify(check.scope) === JSON.stringify(invocation.config.files),
      "Check identity differs",
    );
    terraformRequire(
      packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Input identity differs",
    );
    terraformRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "native") &&
        packet.source === path.join(packet.temporary, "source"),
      "Owned workspace differs",
    );
    terraformRequire(
      path.isAbsolute(packet.tool.entry) &&
        path.isAbsolute(packet.tool.resolved) &&
        packet.tool.sha256 === terraformBinarySha256 &&
        packet.tool.afterSha256 === packet.tool.sha256,
      "Native tool pin differs",
    );
    terraformRequire(
      JSON.stringify(packet.modules) ===
        JSON.stringify(
          modules.map((m) => ({
            file: m.file,
            sha256: m.sha256,
            afterSha256: m.sha256,
            declarations: m.declarations,
          })),
        ),
      "Native copied module closure differs",
    );
    terraformRequire(
      packet.cliConfig.file ===
        path.join(packet.temporary, "home", "terraform.rc") &&
        packet.cliConfig.sha256 === mavenHash("") &&
        packet.cliConfig.afterSha256 === packet.cliConfig.sha256,
      "Fresh CLI configuration differs",
    );
    const receipt = (index: number, phase: string, args: string[]) => {
      const row = packet.receipts[index]!;
      terraformRequire(
        row.phase === phase &&
          row.executable === packet.tool.entry &&
          JSON.stringify(row.args) === JSON.stringify(args) &&
          row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr) &&
          !row.stderr,
        "Native command or output differs",
      );
      return row;
    };
    const version = receipt(0, "version", ["version", "-json"]);
    const identity = z
      .strictObject({
        terraform_version: z.literal("1.16.5"),
        platform: z.literal("linux_arm64"),
        provider_selections: z.record(z.string(), z.string()),
        terraform_outdated: z.boolean(),
      })
      .parse(JSON.parse(version.stdout));
    terraformRequire(
      version.exitCode === 0 &&
        Object.keys(identity.provider_selections).length === 0,
      "Native version/provider profile differs",
    );
    const validation = receipt(1, "validate", [
        "validate",
        "-json",
        "-no-color",
      ]),
      result = nativeResult.parse(JSON.parse(validation.stdout));
    const counts = {
      errors: result.diagnostics.filter((d) => d.severity === "error").length,
      warnings: result.diagnostics.filter((d) => d.severity === "warning")
        .length,
    };
    terraformRequire(
      result.error_count === counts.errors &&
        result.warning_count === counts.warnings &&
        result.valid === (counts.errors === 0),
      "Native diagnostic counts differ",
    );
    terraformRequire(
      validation.exitCode === (counts.errors ? 1 : 0),
      "Native exit differs",
    );
    const findings: Finding[] = [];
    for (const d of result.diagnostics) {
      terraformRequire(
        d.range && d.snippet && d.snippet.values.length === 0,
        "Diagnostic source scope unavailable",
      );
      const input = invocation.inputs.find(
        (i) =>
          i.path === d.range!.filename &&
          invocation.config.files.includes(i.path),
      );
      terraformRequire(input, "Foreign diagnostic source");
      const bytes = Buffer.from(input.text),
        { start, end } = d.range;
      terraformRequire(
        start.byte < end.byte && end.byte <= bytes.length,
        "Diagnostic range differs",
      );
      const point = (p: z.infer<typeof position>) => {
        const before = bytes.subarray(0, p.byte).toString("utf8");
        terraformRequire(
          Buffer.from(before).length === p.byte &&
            before.split("\n").length === p.line &&
            Array.from(
              new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
                before.slice(before.lastIndexOf("\n") + 1),
              ),
            ).length +
              1 ===
              p.column,
          "Physical diagnostic position differs",
        );
      };
      point(start);
      point(end);
      const snippet = d.snippet,
        lines = input.text.split("\n");
      terraformRequire(
        lines
          .slice(
            snippet.start_line - 1,
            snippet.start_line - 1 + snippet.code.split("\n").length,
          )
          .join("\n") === snippet.code,
        "Native source snippet differs",
      );
      terraformRequire(
        snippet.highlight_start_offset < snippet.highlight_end_offset &&
          snippet.highlight_end_offset <= Buffer.byteLength(snippet.code),
        "Native highlight differs",
      );
      const snippetByte = Buffer.byteLength(
        lines.slice(0, snippet.start_line - 1).join("\n") +
          (snippet.start_line > 1 ? "\n" : ""),
      );
      terraformRequire(
        snippetByte + snippet.highlight_start_offset === start.byte &&
          snippetByte + snippet.highlight_end_offset === end.byte,
        "Native range/snippet disagreement",
      );
      findings.push({
        ruleId: "terraform/validate",
        level: d.severity,
        file: input.path,
        line: start.line,
        message: d.summary + (d.detail ? ": " + d.detail : ""),
      });
    }
    if (counts.warnings)
      return {
        ...incomplete,
        reason:
          "Native Terraform validation returned warnings; the bounded warning-free profile is incomplete",
        findings,
      };
    return {
      status: counts.errors ? "failed" : "passed",
      reason: counts.errors
        ? "Native Terraform validation found source-bound module errors"
        : "The complete declared provider-free Terraform JSON module passed native validation",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
