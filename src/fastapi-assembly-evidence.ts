import path from "node:path";
import { z } from "zod";
import { fastapiConfigSchema } from "./fastapi.js";
import {
  fastapiAssemblyResultSchema,
  fastapiAssemblyRouteSchema,
  fastapiAssemblyMiddlewareSchema,
  fastapiAssemblyLifespanSchema,
  fastapiAssemblyBindingSchema,
} from "./fastapi-assembly-schema.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const scopeSchema = z
  .array(
    z.union([
      z.strictObject({
        kind: z.literal("host"),
        host: z.string().min(1).max(4096),
        name: z.string().max(256).nullable(),
      }),
      z.strictObject({
        kind: z.literal("mount"),
        path: z.string().startsWith("/").max(4096),
        name: z.string().max(256).nullable(),
      }),
    ]),
  )
  .max(8);
const dependencySchema = z.strictObject({
  order: z.array(z.number().int().nonnegative()).min(1).max(8),
  call: z.string().min(1).max(1024),
  kind: z.enum(["function", "instance"]),
  useCache: z.boolean(),
  scope: z.enum(["function", "request"]).nullable(),
  ownScopes: z.array(z.string()),
  parentScopes: z.array(z.string()),
  effectiveScopes: z.array(z.string()),
  security: z
    .strictObject({
      scheme: z.string(),
      autoError: z.boolean(),
      model: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});
function decoded(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (canonical(parsed) !== value)
    throw new Error("Noncanonical assembly metadata");
  return parsed;
}
export function fastapiAssemblyEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "FastAPI assembly evidence is unsupported, stale, empty or incomplete.",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("fastapi-runtime"),
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
          "Pinned Python/FastAPI/Starlette/Pydantic versions or selected runtime source bytes are unavailable.",
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
        "FastAPI application, native request or lifespan failed to complete.",
    };
  try {
    const result = fastapiAssemblyResultSchema.parse(
      JSON.parse(execution.stdout),
    );
    const config = fastapiConfigSchema.parse(
      JSON.parse(check.commands[0]!.args[3]!),
    );
    if (
      config.schemaVersion !== 2 ||
      result.runtime.sourceFingerprint !== check.commands[0]!.args[4] ||
      result.runtime.producer.name !== "checktrail.fastapi-routes" ||
      result.runtime.producer.version !== "2.0.0" ||
      result.runtime.assembly.name !== config.assembly ||
      result.runtime.assembly.environment !== config.environment ||
      result.runtime.collections.length !== 4 ||
      result.requests.length !== config.requests.length ||
      !result.applicationRoutes
    )
      return incomplete;
    const kinds = ["routes", "middleware", "listeners", "bindings"] as const;
    const parsers = [
      fastapiAssemblyRouteSchema,
      fastapiAssemblyMiddlewareSchema,
      fastapiAssemblyLifespanSchema,
      fastapiAssemblyBindingSchema,
    ] as const;
    const counts = [
      result.runtime.collections[0]!.entries.length,
      result.middlewareCount,
      result.lifespanCount,
      result.bindingCount,
    ];
    const scopes = new Set<string>();
    for (const [index, collection] of result.runtime.collections.entries()) {
      if (
        collection.kind !== kinds[index] ||
        !collection.ordered ||
        collection.entries.length !== counts[index]
      )
        return incomplete;
      for (const entry of collection.entries) {
        const attrs = parsers[index]!.parse(entry.attributes);
        scopeSchema.parse(decoded(attrs.scope));
        scopes.add(attrs.scope);
        if (entry.key !== canonical(attrs)) return incomplete;
      }
    }
    if (scopes.size !== result.applicationCount) return incomplete;
    const routes = result.runtime.collections[0]!.entries.map((e) =>
      fastapiAssemblyRouteSchema.parse(e.attributes),
    );
    const middleware = result.runtime.collections[1]!.entries.map((e) =>
      fastapiAssemblyMiddlewareSchema.parse(e.attributes),
    );
    const lifespan = result.runtime.collections[2]!.entries.map((e) =>
      fastapiAssemblyLifespanSchema.parse(e.attributes),
    );
    const bindings = result.runtime.collections[3]!.entries.map((e) =>
      fastapiAssemblyBindingSchema.parse(e.attributes),
    );
    const registrations = new Map<string, string>();
    const methods = new Map<string, Set<string>>();
    let applications = 0;
    for (const route of routes) {
      if (route.protocol === "websocket" && route.method !== "WEBSOCKET")
        return incomplete;
      decoded(route.responseOptions);
      if (route.responseModel !== null) decoded(route.responseModel);
      const dependencyOrders = new Set<string>();
      for (const encoded of route.dependencies) {
        const dependency = dependencySchema.parse(decoded(encoded));
        const key = JSON.stringify(dependency.order);
        if (dependencyOrders.has(key)) return incomplete;
        dependencyOrders.add(key);
        const effective = [
          ...new Set([...dependency.parentScopes, ...dependency.ownScopes]),
        ];
        if (canonical(effective) !== canonical(dependency.effectiveScopes))
          return incomplete;
      }
      const id = canonical([route.scope, route.ordinal]);
      const signature = canonical({ ...route, method: null });
      const registered = registrations.get(id),
        seen = methods.get(id) ?? new Set<string>();
      if (
        (registered !== undefined && registered !== signature) ||
        seen.has(route.method)
      )
        return incomplete;
      if (registered === undefined && route.application) applications++;
      seen.add(route.method);
      methods.set(id, seen);
      registrations.set(id, signature);
    }
    if (
      registrations.size !== result.routeCount ||
      applications !== result.applicationRoutes
    )
      return incomplete;
    for (const scope of scopes) {
      if (!lifespan.some((e) => e.scope === scope && e.kind === "context"))
        return incomplete;
      for (const list of [lifespan, bindings]) {
        const members = list.filter((e) => e.scope === scope);
        if (members.some((e, index) => e.position !== index)) return incomplete;
      }
      for (const kind of ["user", "native", "native-unbuilt"] as const) {
        const members = middleware.filter(
          (e) => e.scope === scope && e.kind === kind,
        );
        if (
          members.some(
            (e, index) =>
              e.position !== index ||
              e.constructed !== (kind === "native") ||
              (kind === "user"
                ? e.arguments === null || e.options === null
                : e.arguments !== null || e.options !== null),
          )
        )
          return incomplete;
        for (const e of members)
          if (e.arguments !== null && e.options !== null) {
            decoded(e.arguments);
            decoded(e.options);
          }
      }
      if (
        middleware.some((e) => e.scope === scope && e.kind === "native") &&
        middleware.some((e) => e.scope === scope && e.kind === "native-unbuilt")
      )
        return incomplete;
    }
    const complete = !middleware.some((e) => e.kind === "native-unbuilt");
    if (result.runtime.collections.some((c) => c.complete !== complete))
      return incomplete;
    const findings: NonNullable<CheckResult["findings"]> = [];
    for (const [kind, actual, expected] of [
      ["routes", routes, config.expectedRoutes],
      ["middleware", middleware, config.expectedMiddleware],
      ["lifespan", lifespan, config.expectedLifespan],
      ["bindings", bindings, config.expectedBindings],
    ] as const)
      if (canonical(actual) !== canonical(expected))
        findings.push({
          ruleId: `fastapi/assembly-${kind}-mismatch`,
          level: "error",
          message: `Native FastAPI ${kind} differ from the declared assembly contract.`,
          file: path.posix.join(check.project, "checktrail.fastapi.json"),
        });
    const identities = new Set<string>();
    for (const route of routes) {
      const id = canonical([
        route.scope,
        route.protocol,
        route.method,
        route.path,
      ]);
      if (identities.has(id))
        findings.push({
          ruleId: "fastapi/duplicate-route",
          level: "error",
          message:
            "FastAPI contains an exact duplicate method/path registration in one host/mount scope.",
          file: path.posix.join(check.project, "checktrail.fastapi.json"),
        });
      identities.add(id);
    }
    for (const [index, request] of result.requests.entries()) {
      const { expected, ...input } = config.requests[index]!;
      const { status, responseBody, messages, ...actual } = request;
      if (canonical(actual) !== canonical(input)) return incomplete;
      if (
        canonical({ status, body: responseBody, messages }) !==
        canonical(expected)
      )
        findings.push({
          ruleId: "fastapi/assembly-request-mismatch",
          level: "error",
          message: `Controlled ${request.protocol} request ${index + 1} differs from its declared response.`,
          file: path.posix.join(check.project, "checktrail.fastapi.json"),
        });
    }
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
          "Native FastAPI assembly or controlled responses differ from the declared contract.",
      };
    if (!complete) return { ...evidence, ...incomplete };
    return {
      ...evidence,
      status: "passed",
      reason:
        "Native FastAPI assembly and all completed controlled ASGI requests match the declared contract.",
    };
  } catch {
    return incomplete;
  }
}
