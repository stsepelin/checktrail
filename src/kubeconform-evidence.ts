import path from "node:path";
import { z } from "zod";
import {
  kubeconformInvocationSchema,
  kubeDocuments,
  kubeSchemaPins,
  kubeBinarySha256,
  kubeNativeArgs,
  kubePointerLine,
  kubeRequire,
} from "./kubeconform.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const text = z.string().max(1024 * 1024),
  file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  integer = z.number().int().nonnegative();
export const kubeconformPacketSchema = z.strictObject({
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
  schemas: z
    .array(z.strictObject({ file, sha256: digest, afterSha256: digest }))
    .length(kubeSchemaPins.length),
  documents: z
    .array(
      z.strictObject({
        file,
        source: file,
        index: integer,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .min(1)
    .max(64),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum(["version", "validate"]),
        executable: file,
        args: z.array(file).min(1).max(128),
        exitCode: integer.max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(2),
});
export function kubeconformEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Kubernetes native evidence is incomplete or inconsistent with declared documents, schemas, commands or counters",
    findingsComplete: false,
  };
  try {
    kubeRequire(
      check.commands.length === 1 && processes.length === 1,
      "Process accounting differs",
    );
    const process = processes[0]!;
    kubeRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.signal &&
        !process.errorCode,
      "Native collection incomplete",
    );
    if (process.exitCode === 3) {
      z.strictObject({ unavailable: z.literal("kubeconform-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason:
          "kubeconform is unavailable or outside the pinned Linux ARM64 profile",
        findingsComplete: false,
      };
    }
    kubeRequire(process.exitCode === 0, "Collector failed");
    const invocation = kubeconformInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      documents = kubeDocuments(invocation.inputs, invocation.config),
      packet = kubeconformPacketSchema.parse(JSON.parse(process.stdout));
    kubeRequire(
      check.id === "infrastructure.kubeconform" &&
        JSON.stringify(check.scope) ===
          JSON.stringify(invocation.config.manifests),
      "Check identity differs",
    );
    kubeRequire(
      packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Input pin differs",
    );
    kubeRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "native") &&
        packet.source === path.join(packet.temporary, "source"),
      "Owned directory differs",
    );
    kubeRequire(
      path.isAbsolute(packet.tool.entry) &&
        path.isAbsolute(packet.tool.resolved) &&
        packet.tool.sha256 === kubeBinarySha256 &&
        packet.tool.afterSha256 === packet.tool.sha256,
      "Tool pin differs",
    );
    kubeRequire(
      JSON.stringify(packet.schemas) ===
        JSON.stringify(
          kubeSchemaPins.map((p) => ({
            file: p.file,
            sha256: p.sha256,
            afterSha256: p.sha256,
          })),
        ),
      "Schema closure differs",
    );
    kubeRequire(
      JSON.stringify(packet.documents) ===
        JSON.stringify(
          documents.map((doc, index) => ({
            file: `documents/${index}.yaml`,
            source: doc.file,
            index: doc.index,
            sha256: doc.sha256,
            afterSha256: doc.sha256,
          })),
        ),
      "Copied document scope differs",
    );
    const receipt = (index: number, phase: string, args: string[]) => {
      const row = packet.receipts[index]!;
      kubeRequire(
        row.phase === phase &&
          row.executable === packet.tool.entry &&
          JSON.stringify(row.args) === JSON.stringify(args) &&
          row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
        "Native command/output identity differs",
      );
      return row;
    };
    const version = receipt(0, "version", ["-v"]);
    kubeRequire(
      version.exitCode === 0 &&
        version.stdout === "v0.8.0\n" &&
        !version.stderr,
      "Native version differs",
    );
    const validation = receipt(
      1,
      "validate",
      kubeNativeArgs(invocation.config, packet.workspace, documents.length),
    );
    kubeRequire(!validation.stderr, "Native validation stderr is incomplete");
    const result = z
      .strictObject({
        resources: z
          .array(
            z.strictObject({
              filename: file,
              kind: file,
              name: file,
              version: file,
              status: z.enum([
                "statusValid",
                "statusInvalid",
                "statusError",
                "statusSkipped",
              ]),
              msg: z.string().max(65536),
              validationErrors: z
                .array(
                  z.strictObject({
                    path: z.string().max(8192),
                    msg: z.string().min(1).max(8192),
                  }),
                )
                .max(256)
                .optional(),
            }),
          )
          .min(1)
          .max(64),
        summary: z.strictObject({
          valid: integer,
          invalid: integer,
          errors: integer,
          skipped: integer,
        }),
      })
      .parse(JSON.parse(validation.stdout));
    kubeRequire(
      result.resources.length === documents.length,
      "Native resource total differs",
    );
    const seen = new Set<string>(),
      counts = { valid: 0, invalid: 0, errors: 0, skipped: 0 };
    const findings: Finding[] = [];
    for (const row of result.resources) {
      const index = packet.documents.findIndex((d) => d.file === row.filename);
      kubeRequire(
        index >= 0 && !seen.has(row.filename),
        "Foreign or repeated native resource",
      );
      seen.add(row.filename);
      const document = documents[index]!;
      kubeRequire(
        row.kind === document.kind &&
          row.version === document.version &&
          row.name === document.name,
        "Native resource identity differs",
      );
      if (row.status === "statusValid") {
        counts.valid++;
        kubeRequire(
          row.msg === "" && !row.validationErrors?.length,
          "Valid resource has errors",
        );
      } else if (row.status === "statusInvalid") {
        counts.invalid++;
        kubeRequire(
          row.msg.length > 0 &&
            row.validationErrors &&
            row.validationErrors.length > 0,
          "Native invalid resource lacks diagnostics",
        );
        for (const error of row.validationErrors)
          findings.push({
            ruleId: "kubeconform/schema",
            level: "error",
            file: document.file,
            line: kubePointerLine(document, error.path),
            message: `${document.kind} ${document.name}: ${error.path || "/"}: ${error.msg}`,
          });
      } else if (row.status === "statusError") counts.errors++;
      else counts.skipped++;
    }
    kubeRequire(
      JSON.stringify(result.summary) === JSON.stringify(counts),
      "Native summary differs",
    );
    kubeRequire(
      counts.errors === 0 &&
        counts.skipped === 0 &&
        counts.valid + counts.invalid === documents.length,
      "Native resources incomplete",
    );
    kubeRequire(
      validation.exitCode === (counts.invalid ? 1 : 0),
      "Native exit differs",
    );
    return {
      status: counts.invalid ? "failed" : "passed",
      reason: counts.invalid
        ? "Native Kubernetes schema validation found invalid resources"
        : "All declared Kubernetes documents passed native schema validation",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
