import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { nuxtVersions } from "./nuxt.js";
import {
  nuxtAssemblyConfigSchema,
  nuxtAssemblyResultSchema,
  nuxtHandlerSchema,
  nuxtMiddlewareSchema,
  nuxtConfigBoundarySchema,
  nuxtApiTypeSchema,
} from "./nuxt-assembly-schema.js";
import { vueRouteAttributesSchema } from "./vue-router-protocol.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function nuxtAssemblyEvidence(
  check: Check,
  processes: ProcessResult[],
): Partial<CheckResult> {
  const incomplete = {
    status: "inconclusive" as const,
    findingsComplete: false,
    reason:
      "Nuxt native assembly, source binding, type or controlled-response evidence is incomplete.",
  };
  if (processes.length !== 1) return incomplete;
  const execution = processes[0]!;
  if (execution.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("nuxt-runtime"),
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
          "Pinned Nuxt/Nitro/H3/Vite/TypeScript versions or selected source bytes are unavailable.",
      };
    } catch {
      return incomplete;
    }
  }
  if (execution.exitCode !== 0) return incomplete;
  try {
    const result = nuxtAssemblyResultSchema.parse(JSON.parse(execution.stdout)),
      config = nuxtAssemblyConfigSchema.parse(
        JSON.parse(check.commands[0]!.args[3]!),
      );
    const expectedVersions = {
      ...nuxtVersions,
      h3: "1.15.11",
      vite: "8.3.0",
      typescript: "6.0.3",
    };
    if (
      result.runtime.sourceFingerprint !== check.commands[0]!.args[4] ||
      result.runtime.producer.name !== "checktrail.nuxt" ||
      result.runtime.producer.version !== "2.0.0" ||
      result.runtime.assembly.name !== config.assembly ||
      result.runtime.assembly.environment !== config.environment ||
      result.runtime.collections.length !== 3 ||
      result.requests.length !== config.requests.length ||
      Object.keys(result.versions).length !==
        Object.keys(expectedVersions).length ||
      Object.entries(expectedVersions).some(
        ([name, value]) => result.versions[name] !== value,
      ) ||
      !result.types.supported ||
      JSON.stringify(result.types.consumers) !==
        JSON.stringify(config.consumers) ||
      result.types.apis.length !== config.expectedApis.length
    )
      return incomplete;
    const kinds = ["routes", "middleware", "bindings"];
    for (const [i, collection] of result.runtime.collections.entries())
      if (
        collection.kind !== kinds[i] ||
        !collection.ordered ||
        !collection.complete
      )
        return incomplete;
    const routeEntries = result.runtime.collections[0]!.entries;
    const pages = [];
    let server = false;
    for (const entry of routeEntries) {
      const { family, ...attributes } = entry.attributes;
      if (family === "page" && !server)
        pages.push(vueRouteAttributesSchema.parse(attributes));
      else if (family === "server") {
        server = true;
        nuxtHandlerSchema.parse(attributes);
      } else return incomplete;
      if (entry.key !== family + ":" + hash(attributes)) return incomplete;
    }
    const entry = (family: string, value: Record<string, unknown>) => ({
      key: family + ":" + hash(value),
      attributes: { family, ...value },
    });
    const servers = result.handlers.filter((h) => !h.middleware);
    const expectedRoutes = [
      ...pages.map((p) => entry("page", p)),
      ...servers.map((h) => entry("server", h)),
    ];
    const expectedMiddleware = result.middleware.map((m) =>
      entry("middleware", m),
    );
    const expectedBindings = [
      ...result.runtimeConfig.map((c) => entry("config", c)),
      ...result.types.apis.map((a) => entry("api-type", a)),
    ];
    if (
      JSON.stringify(routeEntries) !== JSON.stringify(expectedRoutes) ||
      JSON.stringify(result.runtime.collections[1]!.entries) !==
        JSON.stringify(expectedMiddleware) ||
      JSON.stringify(result.runtime.collections[2]!.entries) !==
        JSON.stringify(expectedBindings)
    )
      return incomplete;
    for (const entry of result.runtime.collections[1]!.entries) {
      const { family, ...attrs } = entry.attributes;
      if (family !== "middleware") return incomplete;
      nuxtMiddlewareSchema.parse(attrs);
    }
    for (const entry of result.runtime.collections[2]!.entries) {
      const { family, ...attrs } = entry.attributes;
      if (family === "config") nuxtConfigBoundarySchema.parse(attrs);
      else if (family === "api-type") nuxtApiTypeSchema.parse(attrs);
      else return incomplete;
    }
    const h3 = result.middleware.filter((m) => m.phase === "h3"),
      appMiddleware = result.middleware.filter((m) => m.phase !== "h3");
    if (
      !pages.length ||
      !result.handlers.length ||
      JSON.stringify(result.counts) !==
        JSON.stringify([
          pages.length,
          result.handlers.length,
          h3.length,
          appMiddleware.length,
          result.runtimeConfig.length,
          result.types.apis.length,
        ]) ||
      result.handlers.some((h, i) => h.position !== i)
    )
      return incomplete;
    for (const phase of ["h3", "global", "named"]) {
      const rows = result.middleware.filter((m) => m.phase === phase);
      if (rows.some((m, i) => m.position !== i)) return incomplete;
    }
    const configKeys = result.runtimeConfig.map((c) =>
      JSON.stringify([c.visibility, c.key]),
    );
    if (new Set(configKeys).size !== configKeys.length) return incomplete;
    for (const [i, api] of result.types.apis.entries())
      if (
        api.route !== config.expectedApis[i]!.route ||
        api.method !== config.expectedApis[i]!.method ||
        !servers.some(
          (s) =>
            s.route === api.route &&
            s.method === api.method &&
            s.source.startsWith("project:"),
        )
      )
        return incomplete;
    const findings: NonNullable<CheckResult["findings"]> = [],
      file = path.posix.join(check.project, "checktrail.nuxt.json");
    const finding = (rule: string, message: string) =>
      findings.push({ ruleId: rule, level: "error", file, message });
    for (const [kind, actual, expected] of [
      ["pages", pages, config.expectedPages],
      ["handlers", result.handlers, config.expectedHandlers],
      ["middleware", result.middleware, config.expectedMiddleware],
      ["runtime-config", result.runtimeConfig, config.expectedRuntimeConfig],
      ["api-types", result.types.apis, config.expectedApis],
    ] as const)
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        finding(
          "nuxt/assembly-" + kind + "-mismatch",
          "Native Nuxt " + kind + " differ from the declared contract.",
        );
    if (result.types.diagnostics.length)
      finding(
        "nuxt/generated-api-consumer",
        "The selected consumer and native generated server API program report TypeScript diagnostics.",
      );
    const duplicates = new Set<string>();
    for (const handler of servers) {
      const key = JSON.stringify([handler.route, handler.method]);
      if (duplicates.has(key))
        finding(
          "nuxt/duplicate-server-route",
          "Compiled Nitro handlers contain an exact route/method duplicate.",
        );
      duplicates.add(key);
    }
    const covered = new Set<string>();
    for (const [i, request] of result.requests.entries()) {
      const { expected, ...input } = config.requests[i]!;
      if (request.path !== input.path || request.method !== input.method)
        return incomplete;
      if (request.completion === "error-response" && request.status < 400)
        return incomplete;
      if (
        request.serverRoute !== null &&
        !servers.some(
          (h) =>
            h.route === request.serverRoute &&
            (h.method === null || h.method === request.method.toLowerCase()),
        )
      )
        return incomplete;
      for (const event of request.events)
        if (
          !result.middleware.some(
            (m) => m.phase === event.phase && m.position === event.position,
          )
        )
          return incomplete;
      if (request.matched)
        for (const match of request.matched) {
          if (
            !pages.some((p) => p.path === match.path && p.name === match.name)
          )
            return incomplete;
          covered.add(JSON.stringify([match.path, match.name]));
        }
      if (
        request.status !== expected.status ||
        request.serverRoute !== expected.serverRoute ||
        JSON.stringify(request.matched) !== JSON.stringify(expected.matched) ||
        (expected.body !== null && request.responseBody !== expected.body) ||
        expected.includes.some((s) => !request.responseBody.includes(s)) ||
        expected.excludes.some((s) => request.responseBody.includes(s)) ||
        JSON.stringify(request.events) !== JSON.stringify(expected.events)
      )
        finding(
          "nuxt/assembly-request-mismatch",
          "Controlled Nuxt request " +
            (i + 1) +
            " differs from its declared response or middleware invocations.",
        );
    }
    if (pages.some((p) => !covered.has(JSON.stringify([p.path, p.name]))))
      return incomplete;
    for (const api of result.types.apis)
      if (
        !result.requests.some(
          (r) =>
            r.serverRoute === api.route &&
            r.method.toLowerCase() === api.method,
        )
      )
        return findings.length
          ? {
              ...incomplete,
              status: "failed",
              runtime: result.runtime,
              findings,
              reason:
                "A controlled API request failed before its producer participated; broader participation remains incomplete.",
            }
          : incomplete;
    return {
      status: findings.length ? "failed" : "passed",
      findingsComplete: true,
      runtime: result.runtime,
      findings,
      reason: findings.length
        ? "Native Nuxt assembly, selected types or controlled responses differ from the declared contract."
        : "Native Nuxt assembly, selected generated API consumers and all controlled responses match the declared contract.",
    };
  } catch {
    return incomplete;
  }
}
