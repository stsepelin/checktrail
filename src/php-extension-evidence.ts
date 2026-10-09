import path from "node:path";
import { z } from "zod";
import {
  phpExtensionRuntime,
  phpExtensionToolPins,
} from "./php-extension-pins.js";
import {
  phpExtensionManifestSchema,
  phpModelDefaultsSchema,
  phpTypedValueSchema,
} from "./php-extensions.js";
import type { Check, CheckResult, Finding, ProcessResult } from "./types.js";
const identity = z.strictObject({
  class: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const schema = z.strictObject({
  format: z.literal("checktrail-php-extensions-1"),
  manifest: phpExtensionManifestSchema,
  runtime: z.unknown(),
  classes: z.array(identity).max(32),
  models: z
    .array(
      z.strictObject({
        requestedClass: z.string(),
        class: z.string(),
        parents: z.array(identity).min(2).max(32),
        defaults: phpModelDefaultsSchema,
        probes: z
          .array(
            z.strictObject({
              attribute: z.string(),
              attributes: z.record(z.string(), z.json()),
              origin: identity,
              value: phpTypedValueSchema,
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .max(16),
  complete: z.boolean(),
  inputsStable: z.boolean(),
  failure: z.string().nullable(),
});
const canonical = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? Array.isArray(value)
      ? "[" + value.map(canonical).join(",") + "]"
      : "{" +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
          .join(",") +
        "}"
    : JSON.stringify(value);
export function phpExtensionEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
): Pick<CheckResult, "status" | "reason" | "findings" | "findingsComplete"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Native PHP extension, source, reflection, defaults or accessor evidence is incomplete.",
  };
  if (
    !root ||
    check.id !== "php.extensions" ||
    check.kind !== "analysis" ||
    processes.length !== 1 ||
    check.commands.length !== 1 ||
    !check.scope.length
  )
    return incomplete;
  const process = processes[0]!;
  let raw: unknown, expected: unknown;
  try {
    raw = JSON.parse(process.stdout);
    expected = JSON.parse(check.commands[0]!.args.at(-1)!);
  } catch {
    return incomplete;
  }
  const unavailable = z
    .strictObject({
      format: z.literal("checktrail-php-extensions-1"),
      unavailable: z.string().min(1),
    })
    .safeParse(raw);
  if (unavailable.success && process.exitCode === 3)
    return { status: "unavailable", reason: unavailable.data.unavailable };
  const report = schema.safeParse(raw),
    planned = phpExtensionManifestSchema.safeParse(expected);
  if (!report.success || !planned.success) return incomplete;
  const result = report.data,
    manifest = planned.data;
  if (
    canonical(result.manifest) !== canonical(manifest) ||
    canonical(manifest.toolPins) !== canonical(phpExtensionToolPins) ||
    canonical(result.runtime) !== canonical(phpExtensionRuntime) ||
    !result.inputsStable
  )
    return incomplete;
  if (
    !result.complete ||
    result.failure !== null ||
    process.exitCode !== 0 ||
    process.stderr.trim()
  )
    return {
      status: "error",
      reason:
        "Native Laravel initialization, reflection or accessor witnesses did not complete.",
    };
  const declarations = manifest.config.classes;
  if (
    canonical(check.scope) !== canonical(declarations.map((c) => c.path)) ||
    result.classes.length !== declarations.length ||
    result.models.length !== manifest.config.models.length
  )
    return incomplete;
  const sourceClasses = new Map(declarations.map((c) => [c.class, c]));
  const sourceBound = (value: z.infer<typeof identity>) => {
    const declared = sourceClasses.get(value.class);
    return (
      declared?.path === value.path &&
      declared.sha256 === value.sha256 &&
      manifest.bindings.some(
        (b) => b.path === value.path && b.sha256 === value.sha256,
      )
    );
  };
  if (
    new Set(result.classes.map((c) => c.class)).size !== declarations.length ||
    result.classes.some((c) => !sourceBound(c))
  )
    return incomplete;
  const used = new Set<string>();
  const findings: Finding[] = [];
  const finding = (id: string, file: string, message: string) =>
    findings.push({
      ruleId: id,
      level: "error",
      file: path.posix.join(check.project, file),
      message,
    });
  for (const [i, model] of result.models.entries()) {
    const spec = manifest.config.models[i]!;
    if (
      model.requestedClass !== spec.class ||
      model.parents[0]!.class !== model.class ||
      new Set(model.parents.map((p) => p.class)).size !==
        model.parents.length ||
      model.probes.length !== spec.probes.length
    )
      return incomplete;
    for (const [j, parent] of model.parents.entries()) {
      if (j === model.parents.length - 1) {
        const native = phpExtensionToolPins.find(
          (p) =>
            p.path ===
            "laravel/framework/src/Illuminate/Database/Eloquent/Model.php",
        )!;
        if (
          parent.class !== "Illuminate\\Database\\Eloquent\\Model" ||
          parent.path !== "vendor/" + native.path ||
          parent.sha256 !== native.sha256
        )
          return incomplete;
      } else {
        if (!sourceBound(parent)) return incomplete;
        used.add(parent.class);
      }
    }
    if (model.class !== spec.expectedClass)
      finding(
        "php.proxy-resolution",
        sourceClasses.get(spec.class)!.path,
        "Initialized model resolved a different generated proxy class than declared.",
      );
    if (canonical(model.defaults) !== canonical(spec.defaults))
      finding(
        "php.model-defaults",
        sourceClasses.get(model.class)!.path,
        "Initialized native model defaults differ from the declared values.",
      );
    for (const [j, probe] of model.probes.entries()) {
      const expected = spec.probes[j]!;
      if (
        probe.attribute !== expected.attribute ||
        canonical(probe.attributes) !== canonical(expected.attributes) ||
        !sourceBound(probe.origin) ||
        !model.parents.some((p) => canonical(p) === canonical(probe.origin))
      )
        return incomplete;
      if (canonical(probe.value) !== canonical(expected.expected))
        finding(
          "php.accessor",
          probe.origin.path,
          "Native accessor " +
            probe.attribute +
            " returned a different type or value than declared.",
        );
    }
  }
  if (declarations.some((c) => !used.has(c.class))) return incomplete;
  return {
    status: findings.length ? "failed" : "passed",
    reason: findings.length
      ? "Native proxy resolution, inherited defaults or accessor values disagree with the declared contract."
      : "Native PHP extensions, initialized proxies, defaults and every accessor witness match the declared contract.",
    findings,
    findingsComplete: true,
  };
}
