import { z } from "zod";
import path from "node:path";
import { vueRouterConfigSchema } from "./vue-router.js";
import {
  vueRouteAttributesSchema,
  vueRouteKey,
  vueRouterResultSchema,
} from "./vue-router-protocol.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";

export function vueRouterEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Vue Router capture or route probe coverage is empty, malformed or incomplete.",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("vue-router-runtime"),
        reason: z.literal("unsupported-version"),
      }).parse(JSON.parse(execution.stdout));
      return {
        status: "unavailable",
        reason: "The verified Vue Router/Vue versions are not installed.",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (execution.exitCode !== 0)
    return {
      status: "error",
      reason: "Vue Router startup or capture failed.",
      findingsComplete: false,
    };
  try {
    const result = vueRouterResultSchema.parse(JSON.parse(execution.stdout));
    const config = vueRouterConfigSchema.parse(
      JSON.parse(check.commands[0]!.args[4]!),
    );
    const collection = result.runtime.collections[0]!;
    if (
      result.runtime.sourceFingerprint !== check.commands[0]!.args[5] ||
      result.runtime.producer.name !== "checktrail.vue-router" ||
      result.runtime.producer.version !== "1.0.0" ||
      result.runtime.assembly.name !== config.assembly ||
      result.runtime.assembly.environment !== config.environment ||
      result.runtime.collections.length !== 1 ||
      collection.kind !== "routes" ||
      !collection.ordered ||
      collection.complete !== (result.supportedRoutes === result.totalRoutes) ||
      result.supportedRoutes !== collection.entries.length ||
      result.indices.length !== result.supportedRoutes ||
      new Set(result.indices).size !== result.supportedRoutes ||
      result.indices.some(
        (index, offset) =>
          index >= result.totalRoutes ||
          (offset > 0 && index <= result.indices[offset - 1]!),
      ) ||
      result.coveredIndices.some(
        (index, offset) =>
          index >= result.totalRoutes ||
          (offset > 0 && index <= result.coveredIndices[offset - 1]!),
      ) ||
      result.probes.length !== config.probes.length ||
      !result.totalRoutes
    )
      return incomplete;
    const records = new Map<number, { path: string; name: string | null }>();
    for (const [offset, entry] of collection.entries.entries()) {
      const attributes = vueRouteAttributesSchema.parse(entry.attributes);
      if (
        entry.key !== vueRouteKey(attributes) ||
        attributes.globalStrict !== config.strict ||
        attributes.globalSensitive !== config.sensitive
      )
        return incomplete;
      records.set(result.indices[offset]!, {
        path: attributes.path,
        name: attributes.name,
      });
    }
    const observed = new Set<number>();
    const findings = [];
    for (const [index, probe] of result.probes.entries()) {
      if (probe.path !== config.probes[index]!.path) return incomplete;
      const nonnull = probe.indices.filter((value) => value !== null);
      if (
        probe.indices.length !== probe.matched.length ||
        new Set(nonnull).size !== nonnull.length
      )
        return incomplete;
      for (const [offset, recordIndex] of probe.indices.entries()) {
        if (recordIndex === null) continue;
        if (
          recordIndex >= result.totalRoutes ||
          (records.has(recordIndex) &&
            JSON.stringify(records.get(recordIndex)) !==
              JSON.stringify(probe.matched[offset]))
        )
          return incomplete;
        observed.add(recordIndex);
      }
      if (
        JSON.stringify(probe.matched) !==
        JSON.stringify(config.probes[index]!.matched)
      )
        findings.push({
          ruleId: "vue-router/probe-mismatch",
          level: "error" as const,
          message: `Route probe ${probe.path} did not resolve to its expected matched route chain.`,
          file: path.posix.join(check.project, "checktrail.vue-router.json"),
        });
    }
    if (
      JSON.stringify([...observed].sort((a, b) => a - b)) !==
      JSON.stringify(result.coveredIndices)
    )
      return incomplete;
    const complete =
      collection.complete &&
      result.coveredIndices.length === result.totalRoutes;
    const evidence = {
      runtime: result.runtime,
      findings,
      findingsComplete: complete,
    };
    if (findings.length)
      return {
        ...evidence,
        status: "failed",
        reason:
          "Native Vue Router resolution differs from the declared route contract.",
      };
    if (!complete) return { ...evidence, ...incomplete };
    return {
      ...evidence,
      status: "passed",
      reason:
        "Every native route record participated in a probe and all resolved route chains matched the declared contract.",
    };
  } catch {
    return incomplete;
  }
}
