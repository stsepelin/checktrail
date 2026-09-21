import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { nuxtConfigSchema, nuxtVersions } from "./nuxt.js";
import { nuxtResultSchema } from "./nuxt-protocol.js";
import {
  vueRouteAttributesSchema,
  vueRouteKey,
} from "./vue-router-protocol.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
export function nuxtEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Nuxt SSR capture, stable assembly or route participation evidence is incomplete.",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("nuxt-runtime"),
        reason: z.literal("unsupported-version"),
      }).parse(JSON.parse(execution.stdout));
      return {
        status: "unavailable",
        reason: "The verified Nuxt runtime versions are not installed.",
        findingsComplete: false,
      };
    } catch {
      return incomplete;
    }
  }
  if (execution.exitCode !== 0)
    return {
      status: "error",
      reason: "Nuxt build or SSR capture failed.",
      findingsComplete: false,
    };
  try {
    const result = nuxtResultSchema.parse(JSON.parse(execution.stdout));
    const config = nuxtConfigSchema.parse(
      JSON.parse(check.commands[0]!.args[3]!),
    );
    if (
      result.sourceFingerprint !== check.commands[0]!.args[4] ||
      result.probes.length !== config.probes.length ||
      Object.keys(result.versions).length !==
        Object.keys(nuxtVersions).length ||
      Object.entries(nuxtVersions).some(
        ([name, version]) => result.versions[name] !== version,
      )
    )
      return incomplete;
    const collection = result.runtime?.collections[0];
    const entries = collection?.entries ?? [];
    if (result.runtime) {
      if (
        result.runtime.sourceFingerprint !== result.sourceFingerprint ||
        result.runtime.producer.name !== "repo-verifier.nuxt" ||
        result.runtime.producer.version !== "1.0.0" ||
        result.runtime.assembly.name !== config.assembly ||
        result.runtime.assembly.environment !== config.environment ||
        result.runtime.collections.length !== 1 ||
        collection?.kind !== "routes" ||
        !collection.ordered ||
        collection.complete !== (entries.length === result.totalRoutes) ||
        result.indices.length !== entries.length ||
        result.indices.some(
          (value, index) =>
            value >= result.totalRoutes ||
            (index > 0 && value <= result.indices[index - 1]!),
        )
      )
        return incomplete;
      const signature = createHash("sha256")
        .update(
          JSON.stringify({
            totalRoutes: result.totalRoutes,
            indices: result.indices,
            entries,
          }),
        )
        .digest("hex");
      if (result.signature !== signature) return incomplete;
    } else if (
      result.totalRoutes ||
      result.indices.length ||
      result.signature !== null
    )
      return incomplete;
    const records = new Map<number, { path: string; name: string | null }>();
    for (const [offset, entry] of entries.entries()) {
      const attributes = vueRouteAttributesSchema.parse(entry.attributes);
      if (entry.key !== vueRouteKey(attributes)) return incomplete;
      records.set(result.indices[offset]!, {
        path: attributes.path,
        name: attributes.name,
      });
    }
    const observed = new Set<number>();
    const findings = [];
    let capturesComplete = Boolean(collection?.complete && result.totalRoutes);
    for (const [index, probe] of result.probes.entries()) {
      const expected = config.probes[index]!;
      if (probe.path !== expected.path) return incomplete;
      const file = path.posix.join(check.project, "repo-verifier.nuxt.json");
      if (probe.status !== 200)
        findings.push({
          ruleId: "nuxt/http-status",
          level: "error" as const,
          file,
          message: `SSR request ${probe.path} returned HTTP ${probe.status}, expected HTTP 200.`,
        });
      if (!probe.capture) {
        capturesComplete = false;
        continue;
      }
      const capture = probe.capture;
      if (
        !result.runtime ||
        capture.signature !== result.signature ||
        capture.totalRoutes !== result.totalRoutes ||
        capture.supportedRoutes !== entries.length
      )
        capturesComplete = false;
      if (capture.indices.length !== capture.matched.length) return incomplete;
      const nonnull = capture.indices.filter((value) => value !== null);
      if (
        new Set(nonnull).size !== nonnull.length ||
        nonnull.some((value) => value >= capture.totalRoutes)
      )
        return incomplete;
      if (capture.signature === result.signature) {
        for (const [offset, recordIndex] of capture.indices.entries()) {
          if (recordIndex === null) continue;
          if (
            records.has(recordIndex) &&
            JSON.stringify(records.get(recordIndex)) !==
              JSON.stringify(capture.matched[offset])
          )
            return incomplete;
          observed.add(recordIndex);
        }
      }
      if (JSON.stringify(capture.matched) !== JSON.stringify(expected.matched))
        findings.push({
          ruleId: "nuxt/probe-mismatch",
          level: "error" as const,
          file,
          message: `SSR request ${probe.path} did not render its declared matched route chain.`,
        });
    }
    const complete = capturesComplete && observed.size === result.totalRoutes;
    const evidence = {
      ...(result.runtime ? { runtime: result.runtime } : {}),
      findings,
      findingsComplete: complete,
    };
    if (findings.length)
      return {
        ...evidence,
        status: "failed",
        reason: "Nuxt SSR requests differ from the declared route contract.",
      };
    if (!complete) return { ...evidence, ...incomplete };
    return {
      ...evidence,
      status: "passed",
      reason:
        "Every native route participated in a successful SSR request and all matched chains agreed with the declared contract.",
    };
  } catch {
    return incomplete;
  }
}
