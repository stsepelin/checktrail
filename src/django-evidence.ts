import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const count = z.number().int().nonnegative().max(20_000);
const schema = z.strictObject({
  version: z.literal(1),
  djangoVersion: z.literal("6.1.1"),
  visitedNodes: count,
  unsupportedNodes: count,
  runtime: runtimeInventorySchema,
});
const attributesSchema = z.strictObject({
  patterns: z.array(z.string()).min(1).max(33),
  namespaces: z.array(z.string()),
  handler: z.string().min(1),
  name: z.string().nullable(),
  defaultsHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function djangoEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "runtime"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Django URL inventory is empty, unsupported, malformed or incomplete.",
  };
  if (processes.length !== 1) return incomplete;
  if (processes[0]!.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("django-runtime"),
        reason: z.enum(["missing-package", "unsupported-version"]),
      }).parse(JSON.parse(processes[0]!.stdout));
      return {
        status: "unavailable",
        reason: "The pinned Django runtime profile is not installed.",
      };
    } catch {
      return incomplete;
    }
  }
  if (processes[0]!.exitCode !== 0)
    return {
      status: "error",
      reason:
        "Django settings, setup, URL resolver or supported collector could not complete.",
    };
  try {
    const result = schema.parse(JSON.parse(processes[0]!.stdout));
    const profile = JSON.parse(check.commands[0]!.args[2]!);
    const routes = result.runtime.collections[0];
    if (
      result.runtime.sourceFingerprint !== check.commands[0]!.args[3] ||
      result.runtime.producer.name !== "checktrail.django-routes" ||
      result.runtime.producer.version !== "1.0.0" ||
      result.runtime.assembly.name !== profile.assembly ||
      result.runtime.assembly.environment !== profile.environment ||
      result.runtime.collections.length !== 1 ||
      routes?.kind !== "routes" ||
      !routes.ordered ||
      routes.complete !== (result.unsupportedNodes === 0) ||
      !routes.entries.length ||
      routes.entries.length + result.unsupportedNodes > result.visitedNodes
    )
      return incomplete;
    const identities = new Set<string>();
    let duplicates = 0;
    for (const entry of routes.entries) {
      const attributes = attributesSchema.parse(entry.attributes);
      if (entry.key !== JSON.stringify(attributes.patterns)) return incomplete;
      for (const pattern of attributes.patterns) {
        const parsed = z
          .tuple([
            z.enum(["RoutePattern", "RegexPattern"]),
            z.string(),
            z.number().int().nonnegative(),
            z.boolean(),
          ])
          .parse(JSON.parse(pattern));
        if (pattern !== JSON.stringify(parsed)) return incomplete;
      }
      if (identities.has(entry.key)) duplicates++;
      identities.add(entry.key);
    }
    if (duplicates)
      return {
        status: "failed",
        reason: "Django registered exact duplicate native URL pattern chains.",
        runtime: result.runtime,
      };
    if (!routes.complete) return { ...incomplete, runtime: result.runtime };
    return {
      status: "passed",
      reason:
        "Django setup completed and supported native URL pattern chains contain no exact duplicates.",
      runtime: result.runtime,
    };
  } catch {
    return incomplete;
  }
}
