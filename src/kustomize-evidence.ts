import path from "node:path";
import { z } from "zod";
import { parseAllDocuments } from "yaml";
import {
  kubeSchemaPins,
  kubeBinarySha256,
  kubeNativeArgs,
  type KubeDocument,
} from "./kubeconform.js";
import { kubeValidationEvidence } from "./kubeconform-evidence.js";
import {
  kustomizeInvocationSchema,
  kustomizeResources,
  kustomizeCanonical,
  kustomizeBinarySha256,
  kustomizeSourceAddress,
  kustomizeRequire,
  type KustomizeResource,
} from "./kustomize.js";
import { mavenHash } from "./maven.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const file = z.string().min(1).max(8192),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  integer = z.number().int().nonnegative(),
  text = z.string().max(1024 * 1024);
export const kustomizePacketSchema = z.strictObject({
  version: z.literal(1),
  temporary: file,
  workspace: file,
  source: file,
  inputSha256: digest,
  tools: z
    .array(
      z.strictObject({
        entry: file,
        resolved: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .length(2),
  schemas: z
    .array(z.strictObject({ file, sha256: digest, afterSha256: digest }))
    .length(kubeSchemaPins.length),
  documents: z
    .array(
      z.strictObject({
        file,
        source: file,
        sha256: digest,
        afterSha256: digest,
      }),
    )
    .min(1)
    .max(32),
  receipts: z
    .array(
      z.strictObject({
        phase: z.enum([
          "kustomize-version",
          "kubeconform-version",
          "build",
          "validate",
        ]),
        executable: file,
        args: z.array(file).min(1).max(128),
        exitCode: integer.max(255),
        stdout: text,
        stderr: text,
        stdoutSha256: digest,
        stderrSha256: digest,
      }),
    )
    .length(4),
});
export function kustomizeEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Kustomize native evidence is incomplete or inconsistent with declared assembly, source addresses, schemas, tools or commands",
    findingsComplete: false,
  };
  try {
    kustomizeRequire(
      check.commands.length === 1 && processes.length === 1,
      "Process accounting differs",
    );
    const process = processes[0]!;
    kustomizeRequire(
      !process.stderr &&
        !process.truncated &&
        !process.cancelled &&
        !process.timedOut &&
        !process.signal &&
        !process.errorCode,
      "Native collection incomplete",
    );
    if (process.exitCode === 3) {
      z.strictObject({ unavailable: z.literal("kustomize-toolchain") }).parse(
        JSON.parse(process.stdout),
      );
      return {
        status: "unavailable",
        reason:
          "Kustomize or kubeconform is unavailable or outside the pinned Linux ARM64 profile",
        findingsComplete: false,
      };
    }
    kustomizeRequire(process.exitCode === 0, "Collector failed");
    const invocation = kustomizeInvocationSchema.parse(
        JSON.parse(check.commands[0]!.args[2]!),
      ),
      expected = kustomizeResources(invocation),
      packet = kustomizePacketSchema.parse(JSON.parse(process.stdout));
    kustomizeRequire(
      check.id === "infrastructure.kustomize" &&
        kustomizeCanonical(check.scope) ===
          kustomizeCanonical([
            ...invocation.config.kustomizations,
            ...invocation.config.resources,
          ]),
      "Check identity differs",
    );
    kustomizeRequire(
      packet.inputSha256 === mavenHash(JSON.stringify(invocation.inputs)),
      "Input pin differs",
    );
    kustomizeRequire(
      path.isAbsolute(packet.temporary) &&
        path.normalize(packet.temporary) === packet.temporary &&
        packet.workspace === path.join(packet.temporary, "native") &&
        packet.source === path.join(packet.temporary, "source"),
      "Owned directory differs",
    );
    for (const [index, pin] of [
      kustomizeBinarySha256,
      kubeBinarySha256,
    ].entries()) {
      const tool = packet.tools[index]!;
      kustomizeRequire(
        path.isAbsolute(tool.entry) &&
          path.isAbsolute(tool.resolved) &&
          tool.sha256 === pin &&
          tool.afterSha256 === pin,
        "Tool pin differs",
      );
    }
    kustomizeRequire(
      kustomizeCanonical(packet.schemas) ===
        kustomizeCanonical(
          kubeSchemaPins.map((p) => ({
            file: p.file,
            sha256: p.sha256,
            afterSha256: p.sha256,
          })),
        ),
      "Schema closure differs",
    );
    const receipt = (
      index: number,
      phase: string,
      tool: number,
      args: string[],
    ) => {
      const row = packet.receipts[index]!;
      kustomizeRequire(
        row.phase === phase &&
          row.executable === packet.tools[tool]!.entry &&
          kustomizeCanonical(row.args) === kustomizeCanonical(args) &&
          row.stdoutSha256 === mavenHash(row.stdout) &&
          row.stderrSha256 === mavenHash(row.stderr),
        "Native command/output identity differs",
      );
      return row;
    };
    for (const [index, phase, tool, args, banner] of [
      [0, "kustomize-version", 0, ["version"], "v5.8.2\n"],
      [1, "kubeconform-version", 1, ["-v"], "v0.8.0\n"],
    ] as const) {
      const row = receipt(index, phase, tool, [...args]);
      kustomizeRequire(
        row.exitCode === 0 && row.stdout === banner && !row.stderr,
        "Native version differs",
      );
    }
    const build = receipt(2, "build", 0, [
      "build",
      invocation.config.root,
      "--load-restrictor",
      "LoadRestrictionsRootOnly",
    ]);
    kustomizeRequire(
      build.exitCode === 0 && !build.stderr,
      "Native build incomplete",
    );
    const parsed = parseAllDocuments(build.stdout, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
    kustomizeRequire(
      parsed.length === expected.length &&
        packet.documents.length === expected.length,
      "Rendered scope differs",
    );
    const remaining = new Set(expected.map((_e, i) => i)),
      documents: KubeDocument[] = [],
      models: KustomizeResource[] = [];
    for (const [index, doc] of parsed.entries()) {
      kustomizeRequire(
        doc.range && doc.contents && !doc.errors.length && !doc.warnings.length,
        "Rendered syntax incomplete",
      );
      const value = doc.toJS({ maxAliasCount: 0 }) as unknown,
        found = [...remaining].filter(
          (i) =>
            kustomizeCanonical(expected[i]!.value) ===
            kustomizeCanonical(value),
        );
      kustomizeRequire(found.length === 1, "Native assembly differs");
      remaining.delete(found[0]!);
      const model = expected[found[0]!]!,
        raw = build.stdout.slice(doc.range[0], doc.range[2]),
        sha256 = mavenHash(raw),
        file = `documents/${index}.yaml`,
        observed = packet.documents[index]!;
      kustomizeRequire(
        observed.file === file &&
          observed.source === model.source.file &&
          observed.sha256 === sha256 &&
          observed.afterSha256 === sha256,
        "Rendered document/source identity differs",
      );
      documents.push({
        ...model.source,
        file,
        text: raw,
        sha256,
        line: 1,
        name: model.value.metadata.name,
      });
      models.push(model);
    }
    const validation = receipt(
      3,
      "validate",
      1,
      kubeNativeArgs(
        { ...invocation.config, manifests: documents.map((d) => d.file) },
        packet.workspace,
        documents.length,
      ),
    );
    return kubeValidationEvidence(
      validation,
      documents,
      (document, pointer) => {
        const index = documents.indexOf(document);
        kustomizeRequire(index >= 0, "Foreign source address");
        return kustomizeSourceAddress(models[index]!, pointer);
      },
      "kustomize/schema",
    );
  } catch {
    return incomplete;
  }
}
