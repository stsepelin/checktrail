import path from "node:path";
import { z } from "zod";
import { djangoConfigSchema } from "./django.js";
import {
  djangoAssemblyResultSchema,
  djangoAssemblyRouteSchema,
  djangoAssemblyMiddlewareSchema,
  djangoAssemblySignalSchema,
  djangoAssemblyAppSchema,
} from "./django-assembly-schema.js";
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
function decoded(value: string): unknown {
  const result: unknown = JSON.parse(value);
  if (canonical(result) !== value)
    throw Error("Noncanonical assembly metadata");
  return result;
}
export function djangoAssemblyEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Django assembly evidence is unsupported, stale, empty or incomplete.",
    findingsComplete: false,
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("django-runtime"),
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
          "Pinned Python/Django/asgiref versions or selected source bytes are unavailable.",
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
        "Django setup or a native controlled WSGI request failed to complete.",
    };
  try {
    const result = djangoAssemblyResultSchema.parse(
        JSON.parse(execution.stdout),
      ),
      config = djangoConfigSchema.parse(
        JSON.parse(check.commands[0]!.args[3]!),
      );
    if (
      config.schemaVersion !== 2 ||
      result.runtime.sourceFingerprint !== check.commands[0]!.args[4] ||
      result.runtime.producer.name !== "checktrail.django-routes" ||
      result.runtime.producer.version !== "2.0.0" ||
      result.runtime.assembly.name !== config.assembly ||
      result.runtime.assembly.environment !== config.environment ||
      result.runtime.collections.length !== 4 ||
      result.requests.length !== config.requests.length
    )
      return incomplete;
    const kinds = ["routes", "middleware", "listeners", "bindings"] as const,
      parsers = [
        djangoAssemblyRouteSchema,
        djangoAssemblyMiddlewareSchema,
        djangoAssemblySignalSchema,
        djangoAssemblyAppSchema,
      ] as const;
    for (const [i, collection] of result.runtime.collections.entries()) {
      if (
        collection.kind !== kinds[i] ||
        !collection.ordered ||
        !collection.complete ||
        collection.entries.length !== result.counts[i]
      )
        return incomplete;
      for (const entry of collection.entries) {
        const attrs = parsers[i]!.parse(entry.attributes);
        if (entry.key !== canonical(attrs)) return incomplete;
      }
    }
    const routes = result.runtime.collections[0]!.entries.map((e) =>
        djangoAssemblyRouteSchema.parse(e.attributes),
      ),
      middleware = result.runtime.collections[1]!.entries.map((e) =>
        djangoAssemblyMiddlewareSchema.parse(e.attributes),
      ),
      signals = result.runtime.collections[2]!.entries.map((e) =>
        djangoAssemblySignalSchema.parse(e.attributes),
      ),
      apps = result.runtime.collections[3]!.entries.map((e) =>
        djangoAssemblyAppSchema.parse(e.attributes),
      );
    if (
      !routes.length ||
      !apps.length ||
      result.visitedNodes !== routes.length + result.resolverNodes
    )
      return incomplete;
    const ordinals = new Set<string>();
    for (const route of routes) {
      if (
        ordinals.has(route.ordinal) ||
        route.ordinal.split(".").length !== route.patterns.length
      )
        return incomplete;
      ordinals.add(route.ordinal);
      for (const encoded of route.patterns)
        z.tuple([
          z.enum(["RoutePattern", "RegexPattern"]),
          z.string(),
          z.number().int().nonnegative(),
          z.boolean(),
        ]).parse(decoded(encoded));
    }
    for (const phase of [
      "registration",
      "view",
      "template",
      "exception",
    ] as const) {
      const rows = middleware.filter((r) => r.phase === phase);
      if (
        rows.some(
          (r, i) =>
            r.position !== i ||
            (phase === "registration"
              ? r.declared === null
              : r.declared !== null || !r.constructed),
        )
      )
        return incomplete;
    }
    if (
      apps.some((app, i) => app.position !== i) ||
      new Set(apps.map((a) => a.label)).size !== apps.length
    )
      return incomplete;
    const labels = config.signals.map((s) => s.module + "." + s.attribute);
    if (
      new Set(labels).size !== labels.length ||
      signals.some((s) => !labels.includes(s.signal))
    )
      return incomplete;
    for (const label of labels) {
      const rows = signals.filter((s) => s.signal === label);
      if (rows.some((s, i) => s.position !== i)) return incomplete;
      for (const row of rows)
        if (row.dispatchUid !== null) decoded(row.dispatchUid);
    }
    const findings: NonNullable<CheckResult["findings"]> = [];
    for (const [kind, actual, expected] of [
      ["routes", routes, config.expectedRoutes],
      ["middleware", middleware, config.expectedMiddleware],
      ["signals", signals, config.expectedSignals],
      ["apps", apps, config.expectedApps],
    ] as const)
      if (canonical(actual) !== canonical(expected))
        findings.push({
          ruleId: `django/assembly-${kind}-mismatch`,
          level: "error",
          message: `Native Django ${kind} differ from the declared assembly contract.`,
          file: path.posix.join(check.project, "checktrail.django.json"),
        });
    const identities = new Set<string>();
    for (const route of routes) {
      const key = canonical([route.patterns, route.namespaces]);
      if (identities.has(key))
        findings.push({
          ruleId: "django/duplicate-route",
          level: "error",
          message:
            "Django contains an exact duplicate pattern chain in one namespace.",
          file: path.posix.join(check.project, "checktrail.django.json"),
        });
      identities.add(key);
    }
    for (const [i, request] of result.requests.entries()) {
      const { expected, ...input } = config.requests[i]!,
        { status, responseBody, events, ...actual } = request;
      if (
        canonical(input) !== canonical(actual) ||
        events.some((e) => !labels.includes(e.signal))
      )
        return incomplete;
      if (
        canonical({ status, body: responseBody, events }) !==
        canonical(expected)
      )
        findings.push({
          ruleId: "django/assembly-request-mismatch",
          level: "error",
          message: `Controlled WSGI request ${i + 1} differs from its declared response.`,
          file: path.posix.join(check.project, "checktrail.django.json"),
        });
    }
    return {
      runtime: result.runtime,
      findings,
      findingsComplete: true,
      status: findings.length ? "failed" : "passed",
      reason: findings.length
        ? "Native Django assembly or controlled responses differ from the declared contract."
        : "Native Django assembly and all completed controlled WSGI requests match the declared contract.",
    };
  } catch {
    return incomplete;
  }
}
