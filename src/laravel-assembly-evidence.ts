import path from "node:path";
import { z } from "zod";
import {
  laravelAssemblyConfigSchema,
  laravelAssemblyResultSchema,
  validateLaravelAssemblyCollections,
  laravelAssemblyEntryKey,
} from "./laravel-assembly-schema.js";
import { laravelAssemblyVersions } from "./laravel-assembly-runtime-pins.js";
import { laravelAssemblyPhpFlags } from "./laravel.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function laravelAssemblyEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Laravel assembly evidence is unsupported, stale, empty or incomplete.",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("laravel-runtime"),
        reason: z.enum([
          "missing-package",
          "unsupported-version",
          "runtime-byte-mismatch",
        ]),
      }).parse(JSON.parse(execution.stdout));
      return {
        ...incomplete,
        status: "unavailable",
        reason:
          "Pinned PHP/Laravel native versions or selected source bytes are unavailable.",
      };
    } catch {
      return incomplete;
    }
  }
  if (execution.exitCode === 4) return incomplete;
  if (execution.exitCode !== 0)
    return {
      ...incomplete,
      status: "error",
      reason:
        "Laravel native setup or controlled HTTP request failed to complete.",
    };
  try {
    const args = check.commands[0]!.args,
      offset = laravelAssemblyPhpFlags.length;
    if (
      JSON.stringify(args.slice(0, offset)) !==
      JSON.stringify(laravelAssemblyPhpFlags)
    )
      return incomplete;
    const chunks = args.slice(offset + 3);
    if (
      !chunks.length ||
      chunks.some(
        (c) => !c.length || c.length > 65536 || !/^[A-Za-z0-9+/=]+$/.test(c),
      )
    )
      return incomplete;
    const encoded = chunks.join("");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 256 * 1024 || bytes.toString("base64") !== encoded)
      return incomplete;
    const config = laravelAssemblyConfigSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      ),
      result = laravelAssemblyResultSchema.parse(JSON.parse(execution.stdout));
    validateLaravelAssemblyCollections(
      config.expectedCollections,
      config.models,
    );
    validateLaravelAssemblyCollections(
      result.runtime.collections,
      config.models,
    );
    const versions = { php: "8.5.6", ...laravelAssemblyVersions };
    if (
      result.runtime.sourceFingerprint !== args[offset + 2] ||
      result.runtime.producer.name !== "checktrail.laravel-runtime" ||
      result.runtime.producer.version !== "2.0.0" ||
      result.runtime.assembly.name !== config.assembly ||
      result.runtime.assembly.environment !== config.environment ||
      canonical(result.versions) !== canonical(versions) ||
      result.clock !== config.clock ||
      canonical(result.models) !== canonical(config.models) ||
      canonical(result.counts) !==
        canonical(result.runtime.collections.map((c) => c.entries.length)) ||
      result.entryCount !== result.counts.reduce((n, c) => n + c, 0) ||
      result.requests.length !== config.requests.length
    )
      return incomplete;
    const findings: NonNullable<CheckResult["findings"]> = [];
    const finding = (kind: string, message: string) =>
      findings.push({
        ruleId: `laravel/assembly-${kind}-mismatch`,
        level: "error",
        message,
        file: path.posix.join(check.project, "checktrail.laravel.json"),
      });
    for (const [i, c] of result.runtime.collections.entries()) {
      const expected = config.expectedCollections[i]!;
      const normalize = (entries: typeof c.entries) => {
        const rows = entries.map((e) => ({
          ...e,
          key: laravelAssemblyEntryKey(c.kind, e.attributes),
        }));
        return c.ordered
          ? canonical(rows)
          : canonical(rows.map(canonical).sort());
      };
      if (normalize(c.entries) !== normalize(expected.entries))
        finding(
          c.kind,
          `Native Laravel ${c.kind} differ from the declared assembly contract.`,
        );
    }
    for (const [i, actual] of result.requests.entries()) {
      const input = config.requests[i]!;
      const { expected, ...identity } = input;
      const { status, responseBody, exceptionClass, completed, ...received } =
        actual;
      if (
        canonical(received) !== canonical(identity) ||
        completed !== true ||
        Buffer.byteLength(responseBody) > 65536
      )
        return incomplete;
      if (
        status !== expected.status ||
        responseBody !== expected.body ||
        exceptionClass !== expected.exceptionClass
      )
        finding(
          "request",
          `Controlled Laravel ${input.method} request ${input.path} differs from its declared native response.`,
        );
    }
    return {
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "Laravel native registration or controlled response contracts differ."
        : "Laravel native registration contracts and all controlled HTTP requests completed and matched.",
      findings,
      findingsComplete: true,
      runtime: result.runtime,
    };
  } catch {
    return incomplete;
  }
}
