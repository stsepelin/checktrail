import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const count = z.number().int().nonnegative();
const schema = z.strictObject({
  version: z.literal(1),
  versions: z.strictObject({
    fastapi: z.literal("0.141.1"),
    starlette: z.literal("1.6.0"),
  }),
  totalRoutes: count,
  supportedRoutes: count,
  applicationRoutes: count,
  entryRouteIndices: z.array(count),
  runtime: runtimeInventorySchema,
});
const attributesSchema = z.strictObject({
  protocol: z.enum(["http", "websocket"]),
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().startsWith("/"),
  handler: z.string().min(1),
  name: z.string(),
  dependencies: z.array(z.string().min(1)),
  includeInSchema: z.boolean(),
});
export function fastapiEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "runtime"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "FastAPI runtime routes are unsupported, empty, malformed or incomplete.",
  };
  if (processes.length !== 1) return incomplete;
  if (processes[0]!.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("fastapi-runtime"),
        reason: z.enum(["missing-package", "unsupported-version"]),
      }).parse(JSON.parse(processes[0]!.stdout));
      return {
        status: "unavailable",
        reason:
          "The pinned FastAPI/Starlette runtime profile is not installed.",
      };
    } catch {
      return incomplete;
    }
  }
  if (processes[0]!.exitCode !== 0)
    return {
      status: "error",
      reason:
        "FastAPI application, lifespan or supported collector could not complete.",
    };
  try {
    const result = schema.parse(JSON.parse(processes[0]!.stdout));
    const profile = JSON.parse(check.commands[0]!.args[2]!);
    const routes = result.runtime.collections[0];
    if (
      result.runtime.sourceFingerprint !== check.commands[0]?.args[3] ||
      result.runtime.collections.length !== 1 ||
      routes?.kind !== "routes" ||
      !routes.ordered ||
      routes.complete !== (result.supportedRoutes === result.totalRoutes) ||
      result.supportedRoutes > result.totalRoutes ||
      result.applicationRoutes > result.supportedRoutes ||
      routes.entries.length < result.supportedRoutes ||
      result.entryRouteIndices.length !== routes.entries.length ||
      new Set(result.entryRouteIndices).size !== result.supportedRoutes ||
      result.entryRouteIndices.some((index) => index >= result.totalRoutes) ||
      result.entryRouteIndices.some(
        (index, offset) =>
          offset > 0 && index < result.entryRouteIndices[offset - 1]!,
      ) ||
      result.runtime.producer.name !== "checktrail.fastapi-routes" ||
      result.runtime.producer.version !== "1.0.0" ||
      result.runtime.assembly.name !== profile.assembly ||
      result.runtime.assembly.environment !== profile.environment ||
      !result.applicationRoutes
    )
      return incomplete;
    const identities = new Set<string>();
    let duplicates = 0;
    const registrations = new Map<number, Set<string>>();
    const signatures = new Map<number, string>();
    for (const [index, entry] of routes.entries.entries()) {
      const attributes = attributesSchema.parse(entry.attributes);
      const key =
        attributes.protocol === "http"
          ? `HTTP ${attributes.method} ${attributes.path}`
          : `WEBSOCKET ${attributes.path}`;
      if (
        entry.key !== key ||
        (attributes.protocol === "websocket" &&
          attributes.method !== "WEBSOCKET")
      )
        return incomplete;
      const registration = result.entryRouteIndices[index]!;
      const methods = registrations.get(registration) ?? new Set<string>();
      if (methods.has(attributes.method)) return incomplete;
      const signature = JSON.stringify([
        attributes.protocol,
        attributes.path,
        attributes.handler,
        attributes.name,
        attributes.dependencies,
        attributes.includeInSchema,
      ]);
      if (
        signatures.has(registration) &&
        signatures.get(registration) !== signature
      )
        return incomplete;
      signatures.set(registration, signature);
      methods.add(attributes.method);
      registrations.set(registration, methods);
      if (identities.has(entry.key)) duplicates++;
      identities.add(entry.key);
    }
    if (duplicates)
      return {
        status: "failed",
        reason:
          "FastAPI registered exact duplicate method/path routes; inspect the captured runtime inventory.",
        runtime: result.runtime,
      };
    if (!routes.complete) return { ...incomplete, runtime: result.runtime };
    return {
      status: "passed",
      reason:
        "FastAPI lifespan completed and the supported flat route inventory has no exact duplicate method/path registrations.",
      runtime: result.runtime,
    };
  } catch {
    return incomplete;
  }
}
