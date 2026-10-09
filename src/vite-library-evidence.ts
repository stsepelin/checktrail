import path from "node:path";
import {
  viteLibraryManifestSchema,
  viteLibraryReceiptSchema,
} from "./vite-library-contract.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
export function viteLibraryEvidence(
  check: Check,
  processes: ProcessResult[],
  root?: string,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Native library build, declaration or downstream participation is incomplete",
  };
  if (!root || processes.length !== 1 || check.commands[0]!.args.length !== 5)
    return incomplete;
  try {
    const process = processes[0]!;
    const data = JSON.parse(process.stdout);
    if (
      process.exitCode === 3 &&
      data.unavailable === "vite-library" &&
      [
        "missing-runtime",
        "unsupported-version",
        "runtime-byte-mismatch",
        "unsupported-native-platform",
        "native-binding-byte-mismatch",
      ].includes(data.reason)
    )
      return {
        status: "unavailable",
        reason: "Selected native library tooling is unavailable",
      };
    const manifest = viteLibraryManifestSchema.parse(
      JSON.parse(check.commands[0]!.args[4]!),
    );
    const receipt = viteLibraryReceiptSchema.parse(data);
    if (
      JSON.stringify(receipt.manifest) !== JSON.stringify(manifest) ||
      JSON.stringify(check.scope) !==
        JSON.stringify(
          [...manifest.sources, ...manifest.consumers].map((f) => f.path),
        ) ||
      ![0, 1].includes(process.exitCode ?? -1) ||
      process.stderr.trim()
    )
      return incomplete;
    const sources = manifest.sources.map((f) =>
      path.resolve(root, check.project, f.path),
    );
    const consumers = manifest.consumers.map((f) =>
      path.resolve(root, check.project, f.path),
    );
    if (
      receipt.diagnostics.some(
        (d) =>
          d.file && ![...sources, ...consumers].includes(path.resolve(d.file)),
      )
    )
      return incomplete;
    const findings = receipt.diagnostics.map((d) => ({
      ruleId: "TS" + d.code,
      level: "error" as const,
      message: d.message,
      ...(d.file
        ? { file: path.relative(root, d.file).split(path.sep).join("/") }
        : {}),
      ...(d.line ? { line: d.line } : {}),
    }));
    if (findings.length && process.exitCode === 1)
      return {
        status: "failed",
        reason:
          "Native TypeScript reported a library or downstream contract defect",
        findings,
        findingsComplete: false,
      };
    if (
      process.exitCode !== 0 ||
      !receipt.complete ||
      !receipt.declarations.length ||
      receipt.builds.length !== 2 ||
      new Set(receipt.builds.map((b) => b.format)).size !== 2 ||
      new Set(receipt.producerFiles).size !== sources.length ||
      sources.some((f) => !receipt.producerFiles.includes(f)) ||
      consumers.some(
        (f) =>
          !receipt.consumerFiles.includes(f) ||
          !receipt.resolutions.some((r) => r.consumer === f),
      ) ||
      receipt.builds.some(
        (b) =>
          b.chunks.length !== 1 ||
          b.modules.length !== sources.length ||
          new Set(b.modules).size !== sources.length ||
          sources.some((f) => !b.modules.includes(f)) ||
          b.chunks[0]!.entry !==
            path.resolve(root, check.project, manifest.profile.entry) ||
          !b.chunks[0]!.artifact.bytes ||
          !b.chunks[0]!.exports.length ||
          b.chunks[0]!.imports.length ||
          b.chunks[0]!.dynamicImports.length,
      ) ||
      JSON.stringify(receipt.builds[0]!.chunks[0]!.exports) !==
        JSON.stringify(receipt.builds[1]!.chunks[0]!.exports)
    )
      return incomplete;
    return {
      status: "passed",
      reason:
        "Both native formats and all declared consumers use the same fresh source-bound declaration build",
      findings,
      findingsComplete: true,
    };
  } catch {
    return incomplete;
  }
}
