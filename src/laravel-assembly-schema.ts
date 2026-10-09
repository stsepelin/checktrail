import { z } from "zod";
import { runtimeInventorySchema } from "./runtime-inventory.js";
import { laravelLegacyAttributeSchemas } from "./laravel-protocol.js";
const label = z.string().min(1).max(4096),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  position = z.number().int().min(0).max(1023);
export const laravelAssemblyAttributeSchemas = {
  ...laravelLegacyAttributeSchemas,
  bindings: z.discriminatedUnion("type", [
    ...laravelLegacyAttributeSchemas.bindings.options,
    z.strictObject({
      type: z.literal("tag"),
      name: label,
      abstracts: z.array(label).max(1024),
    }),
    z.strictObject({
      type: z.literal("extender"),
      abstract: label,
      position,
      target: label,
    }),
    z.strictObject({ type: z.literal("method"), method: label, target: label }),
    z.strictObject({
      type: z.literal("model-defaults"),
      requestedClass: label,
      class: label,
      table: label,
      connection: label.nullable(),
      keyName: label,
      keyType: label,
      incrementing: z.boolean(),
      timestamps: z.boolean(),
      perPage: z.number().int().min(1).max(1000000),
      eagerLoadsHash: hash,
      eagerCountsHash: hash,
      castsHash: hash,
      defaultsHash: hash,
      appends: z.array(label).max(1024),
      fillable: z.array(label).max(1024),
      guarded: z.array(label).max(1024),
      globalScopes: z.array(label).max(1024),
      lazyLoadingPrevented: z.boolean(),
      lazyLoadingHandler: label.nullable(),
    }),
  ]),
};
const method = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const request = z.strictObject({
  path: z
    .string()
    .regex(/^\/(?!\/)[^\r\n#]*$/)
    .max(4096),
  method,
  host: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
    .max(256),
  port: z.number().int().min(1).max(65535),
  headers: z
    .array(
      z.strictObject({
        name: z
          .string()
          .regex(/^[A-Za-z0-9-]+$/)
          .max(256),
        value: z
          .string()
          .regex(/^[^\r\n\0]*$/)
          .max(4096),
      }),
    )
    .max(32),
  body: z.string().max(32768).nullable(),
});
const response = z.strictObject({
  status: z.number().int().min(100).max(599),
  body: z.string().max(65536),
  exceptionClass: label.nullable(),
});
export const laravelAssemblyConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  assembly: label,
  environment: z.literal("testing"),
  clock: z.iso
    .datetime()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/),
  models: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/)
        .max(256),
    )
    .min(1)
    .max(16),
  expectedCollections: runtimeInventorySchema.shape.collections,
  requests: z
    .array(request.extend({ expected: response }))
    .min(1)
    .max(32),
});
export const laravelAssemblyResultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  versions: z.record(z.string(), z.string()),
  entryCount: z.number().int().nonnegative().max(20000),
  counts: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  clock: z.iso
    .datetime()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/),
  models: z.array(z.string()).min(1).max(16),
  runtime: runtimeInventorySchema,
  requests: z
    .array(
      request.extend({
        status: z.number().int().min(100).max(599),
        responseBody: z.string().max(65536),
        exceptionClass: label.nullable(),
        completed: z.literal(true),
      }),
    )
    .min(1)
    .max(32),
});
export type LaravelAssemblyConfig = z.infer<typeof laravelAssemblyConfigSchema>;

export const laravelAssemblyKinds = [
  "routes",
  "middleware",
  "listeners",
  "schedules",
  "bindings",
] as const;
export function laravelAssemblyEntryKey(
  kind: (typeof laravelAssemblyKinds)[number],
  attributes: unknown,
): string {
  const a = laravelAssemblyAttributeSchemas[kind].parse(attributes) as Record<
    string,
    unknown
  >;
  if (kind === "routes") return JSON.stringify([a.domain, a.method, a.uri]);
  if (kind === "listeners") return `${a.type}:${a.event}`;
  if (kind === "schedules") return `${a.type}:${a.target}`;
  if (kind === "middleware")
    return a.type === "global" || a.type === "priority"
      ? String(a.type)
      : `${a.type}:${a.name}`;
  if (a.type === "contextual") return `contextual:${a.consumer}:${a.abstract}`;
  if (a.type === "tag") return `tag:${a.name}`;
  if (a.type === "extender") return `extender:${a.abstract}:${a.position}`;
  if (a.type === "method") return `method:${a.method}`;
  if (a.type === "model-defaults") return `model-defaults:${a.requestedClass}`;
  return `${a.type}:${a.abstract}`;
}
export function validateLaravelAssemblyCollections(
  collections: z.infer<typeof runtimeInventorySchema>["collections"],
  models: string[],
): void {
  if (
    collections.length !== 5 ||
    collections.reduce((n, c) => n + c.entries.length, 0) > 20000
  )
    throw Error("Laravel requires five bounded native collections");
  for (const [i, c] of collections.entries()) {
    if (
      c.kind !== laravelAssemblyKinds[i] ||
      !c.complete ||
      c.ordered !== (c.kind !== "bindings")
    )
      throw Error(
        "Laravel collections must have exact kinds, order declarations and completeness",
      );
    for (const e of c.entries)
      if (
        (c.kind === "routes" ? JSON.stringify(JSON.parse(e.key)) : e.key) !==
        laravelAssemblyEntryKey(c.kind, e.attributes)
      )
        throw Error(
          "Laravel entry key does not describe its native attributes",
        );
  }
  if (
    !collections[0]!.entries.length ||
    !collections[4]!.entries.length ||
    ["global", "priority"].some(
      (key) =>
        collections[1]!.entries.filter((e) => e.key === key).length !== 1,
    )
  )
    throw Error(
      "Laravel native route, binding or middleware projection is empty",
    );
  const selected = collections[4]!.entries
    .filter((e) => e.attributes.type === "model-defaults")
    .map((e) => e.attributes.requestedClass);
  if (
    JSON.stringify([...selected].sort()) !== JSON.stringify([...models].sort())
  )
    throw Error("Laravel selected model defaults differ from declared classes");
  const extenders = new Map<string, number[]>();
  for (const e of collections[4]!.entries)
    if (e.attributes.type === "extender") {
      const a = laravelAssemblyAttributeSchemas.bindings.parse(e.attributes);
      if (a.type === "extender")
        extenders.set(a.abstract, [
          ...(extenders.get(a.abstract) ?? []),
          a.position,
        ]);
    }
  for (const positions of extenders.values())
    if ([...positions].sort((a, b) => a - b).some((n, i) => n !== i))
      throw Error("Laravel extender positions must be contiguous");
}
