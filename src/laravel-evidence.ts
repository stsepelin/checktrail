import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import { laravelConfigSchema } from "./laravel.js";
import type { Check, CheckResult, ProcessResult } from "./types.js";

const text = z.string();
const hash = text.regex(/^[a-f0-9]{64}$/);
const attributes = {
  routes: z.strictObject({
    domain: text.nullable(),
    method: text.min(1),
    uri: text.min(1),
    name: text.nullable(),
    handler: text.min(1),
    middleware: z.array(text),
    constraintsHash: hash,
    defaultsHash: hash,
  }),
  middleware: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.enum(["global", "priority"]),
      stack: z.array(text),
    }),
    z.strictObject({
      type: z.literal("group"),
      name: text,
      stack: z.array(text),
    }),
    z.strictObject({ type: z.literal("alias"), name: text, target: text }),
  ]),
  listeners: z.strictObject({
    type: z.enum(["exact", "wildcard"]),
    event: text,
    listener: text,
  }),
  schedules: z.strictObject({
    type: z.enum(["callback", "command"]),
    target: text,
    expression: text,
    repeatSeconds: z.number().int().nullable(),
    user: text.nullable(),
    environments: z.array(text),
    evenInMaintenanceMode: z.boolean(),
    evenWhenPaused: z.boolean(),
    withoutOverlapping: z.boolean(),
    releaseOnTerminationSignals: z.boolean(),
    onOneServer: z.boolean(),
    expiresAt: z.number().int(),
    runInBackground: z.boolean(),
    description: text.nullable(),
    output: text,
    shouldAppendOutput: z.boolean(),
    timezone: text.nullable(),
    parametersHash: hash,
    filters: z.array(text),
    rejects: z.array(text),
    beforeCallbacks: z.array(text),
    afterCallbacks: z.array(text),
    mutex: text,
    mutexNameResolver: text.nullable(),
    attributesHash: hash,
  }),
  bindings: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("factory"),
      abstract: text,
      target: text,
      shared: z.boolean(),
      scoped: z.boolean(),
    }),
    z.strictObject({
      type: z.enum(["alias", "instance"]),
      abstract: text,
      target: text,
    }),
    z.strictObject({
      type: z.literal("contextual"),
      consumer: text,
      abstract: text,
      target: text,
    }),
  ]),
};
const schema = z.strictObject({
  version: z.literal(1),
  laravelVersion: z.literal("13.32.0"),
  entryCount: z.number().int().nonnegative().max(20_000),
  runtime: runtimeInventorySchema,
});

export function laravelEvidence(
  check: Check,
  processes: ProcessResult[],
): Pick<CheckResult, "status" | "reason" | "runtime"> {
  const incomplete = {
    status: "inconclusive" as const,
    reason:
      "Laravel assembly projection is unsupported, malformed, empty or incomplete.",
  };
  if (processes.length !== 1) return incomplete;
  if (processes[0]!.exitCode === 3) {
    try {
      z.strictObject({
        unavailable: z.literal("laravel-runtime"),
        reason: z.literal("unsupported-version"),
      }).parse(JSON.parse(processes[0]!.stdout));
      return {
        status: "unavailable",
        reason: "The pinned Laravel runtime profile is not installed.",
      };
    } catch {
      return incomplete;
    }
  }
  if (processes[0]!.exitCode !== 0)
    return {
      status: "error",
      reason: "Laravel bootstrap or runtime collector failed.",
    };
  try {
    const result = schema.parse(JSON.parse(processes[0]!.stdout));
    const profile = laravelConfigSchema.parse(
      JSON.parse(check.commands[0]!.args[3]!),
    );
    const runtime = result.runtime;
    if (
      runtime.sourceFingerprint !== check.commands[0]!.args[4] ||
      runtime.producer.name !== "repo-verifier.laravel-runtime" ||
      runtime.producer.version !== "1.0.0" ||
      runtime.assembly.name !== profile.assembly ||
      runtime.assembly.environment !== profile.environment ||
      runtime.collections.length !== 5 ||
      new Set(runtime.collections.map((item) => item.kind)).size !== 5 ||
      runtime.collections.reduce(
        (sum, item) => sum + item.entries.length,
        0,
      ) !== result.entryCount
    )
      return incomplete;
    for (const collection of runtime.collections) {
      if (collection.ordered !== (collection.kind !== "bindings"))
        return incomplete;
      for (const entry of collection.entries) {
        const value = attributes[collection.kind].parse(entry.attributes);
        if (collection.kind === "routes") {
          const route = attributes.routes.parse(value);
          if (
            JSON.stringify(JSON.parse(entry.key)) !==
            JSON.stringify([route.domain, route.method, route.uri])
          )
            return incomplete;
        } else {
          const record = value as Record<string, unknown>;
          const expected =
            collection.kind === "listeners"
              ? `${record.type}:${record.event}`
              : collection.kind === "schedules"
                ? `${record.type}:${record.target}`
                : collection.kind === "bindings"
                  ? record.type === "contextual"
                    ? `contextual:${record.consumer}:${record.abstract}`
                    : `${record.type}:${record.abstract}`
                  : record.type === "global" || record.type === "priority"
                    ? record.type
                    : `${record.type}:${record.name}`;
          if (entry.key !== expected) return incomplete;
        }
      }
    }
    if (
      !runtime.collections.find((item) => item.kind === "routes")!.entries
        .length ||
      !runtime.collections.find((item) => item.kind === "bindings")!.entries
        .length ||
      ["global", "priority"].some(
        (key) =>
          runtime.collections
            .find((item) => item.kind === "middleware")!
            .entries.filter((entry) => entry.key === key).length !== 1,
      ) ||
      runtime.collections.some((item) => !item.complete)
    )
      return { ...incomplete, runtime };
    return {
      status: "passed",
      reason:
        "Laravel testing bootstrap completed and all five declared assembly projections were captured; compare inventories to evaluate wiring changes.",
      runtime,
    };
  } catch {
    return incomplete;
  }
}
