import path from "node:path";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import { mavenHash } from "./maven.js";
import { kustomizeCanonical } from "./kustomize.js";
import { kubePointerLine } from "./kubeconform.js";
import {
  helmInvocationSchema,
  helmInputs,
  helmRequire,
  helmBinarySha256,
  helmVersionArgs,
  helmLintArgs,
  helmRenderArgs,
} from "./helm.js";
import type { Check, CheckResult, ProcessResult, Finding } from "./types.js";
const file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  text = z.string().max(1024 * 1024);
export const helmPacketSchema = z.strictObject({
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
  inputs: z
    .array(
      z.strictObject({
        file,
        originalAfterSha256: digest,
        sourceAfterSha256: digest,
        nativeAfterSha256: digest.optional(),
      }),
    )
    .min(5)
    .max(20),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum(["version", "lint", "render"]),
        executable: file,
        args: z.array(file).min(1).max(32),
        exitCode: z.number().int().min(0).max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(3),
});
export function helmEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Helm native evidence is incomplete or inconsistent with declared chart, source addresses, tools, commands or rendered participation",
    findingsComplete: false,
  };
  try {
    helmRequire(
      check.commands.length === 1 && processes.length === 1,
      "Process accounting differs",
    );
    const process = processes[0]!;
    helmRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.signal &&
        !process.errorCode,
      "Native collection incomplete",
    );
    if (process.exitCode === 3) {
      z.strictObject({ unavailable: z.literal("helm-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason: "Helm is unavailable or outside the pinned Linux ARM64 profile",
        findingsComplete: false,
      };
    }
    helmRequire(process.exitCode === 0, "Collector failed");
    const invocation = helmInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      model = helmInputs(invocation),
      packet = helmPacketSchema.parse(JSON.parse(process.stdout));
    helmRequire(
      check.id === "infrastructure.helm" &&
        kustomizeCanonical(check.scope) === kustomizeCanonical(model.scope) &&
        packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Check/input identity differs",
    );
    helmRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "native") &&
        packet.source === path.join(packet.temporary, "source"),
      "Owned directory differs",
    );
    helmRequire(
      path.isAbsolute(packet.tool.entry) &&
        path.isAbsolute(packet.tool.resolved) &&
        packet.tool.sha256 === helmBinarySha256 &&
        packet.tool.afterSha256 === helmBinarySha256,
      "Tool pin differs",
    );
    helmRequire(
      kustomizeCanonical(packet.inputs) ===
        kustomizeCanonical(
          invocation.inputs.map((i) => ({
            file: i.path,
            originalAfterSha256: i.sha256,
            sourceAfterSha256: i.sha256,
            ...(i.path !== "checktrail.helm.json"
              ? { nativeAfterSha256: i.sha256 }
              : {}),
          })),
        ),
      "Source/copy pins differ",
    );
    for (const [index, args] of [
      helmVersionArgs,
      helmLintArgs,
      helmRenderArgs,
    ].entries()) {
      const row = packet.receipts[index]!;
      helmRequire(
        row.phase === ["version", "lint", "render"][index] &&
          row.executable === packet.tool.entry &&
          kustomizeCanonical(row.args) === kustomizeCanonical(args) &&
          row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
        "Native receipt differs",
      );
    }
    const [version, lint, render] = packet.receipts;
    helmRequire(
      version!.exitCode === 0 &&
        version!.stdout === "v4.3.0" &&
        !version!.stderr,
      "Native version differs",
    );
    const cleanLint =
      "==> Linting chart\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n";
    if (lint!.exitCode === 0 && render!.exitCode === 0) {
      helmRequire(
        lint!.stdout === cleanLint && !lint!.stderr && !render!.stderr,
        "Clean native output differs",
      );
      const docs = parseAllDocuments(render!.stdout, {
        strict: true,
        uniqueKeys: true,
        prettyErrors: false,
      });
      helmRequire(
        docs.length === invocation.config.templates.length,
        "Rendered scope differs",
      );
      const remaining = new Set(invocation.config.templates),
        identities = new Set<string>();
      for (const doc of docs) {
        helmRequire(
          doc.contents &&
            doc.range &&
            !doc.errors.length &&
            !doc.warnings.length,
          "Rendered syntax incomplete",
        );
        const raw = render!.stdout.slice(doc.range[0], doc.range[2]);
        const prefix = /^---\n# Source: ([^\n]+)\n/.exec(raw);
        helmRequire(prefix, "Native source header missing");
        const address = prefix[1]!,
          source = address.slice(model.chart.name.length + 1);
        helmRequire(
          address.startsWith(model.chart.name + "/") &&
            remaining.delete(source) &&
            raw.match(/^# Source:/gm)?.length === 1,
          "Rendered source participation differs",
        );
        const value = z
          .object({
            apiVersion: z.string().min(1),
            kind: z.string().min(1),
            metadata: z.object({
              name: z.string().min(1),
              namespace: z.string().optional(),
            }),
          })
          .parse(doc.toJS({ maxAliasCount: 0 }));
        const key = JSON.stringify([
          value.apiVersion,
          value.kind,
          value.metadata.namespace ?? "",
          value.metadata.name,
        ]);
        helmRequire(!identities.has(key), "Duplicate rendered identity");
        identities.add(key);
      }
      helmRequire(remaining.size === 0, "Empty or omitted template");
      return {
        status: "passed",
        reason:
          "Pinned native Helm strict lint and client-only render completed with every declared resource template; Kubernetes API/schema validity is not assessed",
        findings: [],
        findingsComplete: true,
      };
    }
    helmRequire(
      lint!.exitCode === 1 &&
        render!.exitCode === 1 &&
        !render!.stdout &&
        lint!.stderr === "Error: 1 chart(s) linted, 1 chart(s) failed\n",
      "Native failure accounting differs",
    );
    const name = model.chart.name;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let finding: Finding;
    const values = new RegExp(
      "^Error: values don't meet the specifications of the schema\\(s\\) in the following chart\\(s\\):\\n" +
        escaped +
        ":\\n- at '/([A-Za-z][A-Za-z0-9_]*)': got (string|integer|boolean|number), want (string|integer|boolean)\\n\\n$",
    ).exec(render!.stderr);
    if (values) {
      const [, key, actual, wanted] = values;
      const value = model.values[key!]!,
        type =
          typeof value === "number"
            ? Number.isInteger(value)
              ? "integer"
              : "number"
            : typeof value;
      helmRequire(
        type === actual &&
          model.schema.properties[key!]?.type === wanted &&
          actual !== wanted,
        "Value diagnostic disagrees with source",
      );
      const message = `- at '/${key}': got ${actual}, want ${wanted}`;
      helmRequire(
        lint!.stdout ===
          `==> Linting chart\n[INFO] Chart.yaml: icon is recommended\n[ERROR] values.yaml: ${message}\n\n[ERROR] templates/: values don't meet the specifications of the schema(s) in the following chart(s):\n${name}:\n${message}\n\n\n`,
        "Lint value failure differs",
      );
      const input = model.get("values.yaml");
      const line = kubePointerLine(
        {
          file: input.path,
          index: 0,
          text: input.text,
          sha256: input.sha256,
          kind: "values",
          version: "1",
          line: 1,
          name: "values",
        },
        "/" + key,
      );
      finding = {
        ruleId: "helm/values-schema",
        level: "error",
        file: "values.yaml",
        line,
        message: `Native Helm values schema rejected ${key}: ${actual} instead of ${wanted}`,
      };
    } else {
      const parse = new RegExp(
        "^Error: parse error at \\(" +
          escaped +
          "/(templates/[A-Za-z0-9][A-Za-z0-9_.-]*\\.yaml):(\\d+)\\): ([^\\n]+)\\n\\nUse --debug flag to render out invalid YAML\\n$",
      ).exec(render!.stderr);
      const execute = new RegExp(
        "^Error: " +
          escaped +
          '/(templates/[A-Za-z0-9][A-Za-z0-9_.-]*\\.yaml):(\\d+):(\\d+)\\n  executing "' +
          escaped +
          '/\\1" at <([^\\n]+)>:\\n    ([^\\n]+)\\n\\nUse --debug flag to render out invalid YAML\\n$',
      ).exec(render!.stderr);
      helmRequire(
        parse || execute,
        "No verified physical source address (rendered YAML lines are unresolved)",
      );
      const match = (parse ?? execute)!,
        file = match[1]!,
        line = Number(match[2]);
      helmRequire(
        invocation.config.templates.includes(file),
        "Foreign template address",
      );
      const lines = model.get(file).text.split("\n");
      helmRequire(
        line >= 1 && line <= lines.length && lines[line - 1]!.includes("{{"),
        "Physical source line differs",
      );
      if (execute) {
        const column = Number(execute[3]);
        helmRequire(
          column >= 1 &&
            column <= Buffer.byteLength(lines[line - 1]!) + 1 &&
            lines[line - 1]!.includes(execute[4]!),
          "Execution address differs",
        );
      }
      const diagnostic = render!.stderr
        .slice("Error: ".length)
        .replace(/Use --debug flag to render out invalid YAML\n$/, "");
      helmRequire(
        lint!.stdout ===
          "==> Linting chart\n[INFO] Chart.yaml: icon is recommended\n[ERROR] templates/: " +
            diagnostic,
        "Unaccounted or conflicting native lint diagnostics",
      );
      finding = {
        ruleId: "helm/template",
        level: "error",
        file,
        line,
        message: parse
          ? `Native Helm template parse failed: ${parse[3]}`
          : `Native Helm template execution failed: ${execute![5]}`,
      };
    }
    return {
      status: "failed",
      reason:
        "Pinned native Helm lint and rendering rejected a source-bound values or Go-template error",
      findings: [finding],
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
