import { createHash } from "node:crypto";
import { z } from "zod";
import { VERSION } from "./types.js";

const label = z.string().min(1).max(4096);
const kind = z.enum([
  "routes",
  "listeners",
  "middleware",
  "schedules",
  "bindings",
]);
const attribute = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(4096)).max(1024),
]);
export const runtimeInventorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("runtime-inventory"),
  producer: z.strictObject({ name: label, version: label }),
  assembly: z.strictObject({ name: label, environment: label }),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(),
  collections: z
    .array(
      z.strictObject({
        kind,
        complete: z.boolean(),
        ordered: z.boolean(),
        entries: z
          .array(
            z.strictObject({
              key: label,
              attributes: z.record(label, attribute),
            }),
          )
          .max(20_000),
      }),
    )
    .min(1)
    .max(5),
});
export type RuntimeInventory = z.infer<typeof runtimeInventorySchema>;
const count = z.number().int().nonnegative();
export const runtimeComparisonSchema = z.strictObject({
  schemaVersion: z.literal(1),
  engineVersion: z.string(),
  provenance: z.literal("imported-runtime-comparison"),
  outcome: z.enum(["passed", "failed", "incomplete"]),
  reason: z.string(),
  beforeFingerprint: z.string(),
  afterFingerprint: z.string(),
  counts: z.strictObject({
    collections: count,
    compared: count,
    unverified: count,
    changed: count,
    added: count,
    removed: count,
  }),
  collections: z.array(
    z.strictObject({
      kind,
      status: z.enum(["unchanged", "changed", "unverified"]),
      beforeCount: count,
      afterCount: count,
      added: count,
      removed: count,
      orderChanged: z.boolean(),
      changedKeys: z.array(label),
    }),
  ),
});
export const runtimeComparisonSummarySchema = runtimeComparisonSchema.omit({
  collections: true,
});
export type RuntimeComparison = z.infer<typeof runtimeComparisonSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function parse(input: unknown): RuntimeInventory {
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024)
    throw new Error("Runtime inventory exceeds artifact limit");
  const result = runtimeInventorySchema.parse(input);
  if (
    new Set(result.collections.map((collection) => collection.kind)).size !==
    result.collections.length
  )
    throw new Error("Duplicate runtime collection kind");
  if (
    result.collections.reduce(
      (sum, collection) => sum + collection.entries.length,
      0,
    ) > 20_000
  )
    throw new Error("Runtime inventory exceeds entry limit");
  return result;
}

export function compareRuntimeInventories(
  beforeInput: unknown,
  afterInput: unknown,
): RuntimeComparison {
  const before = parse(beforeInput);
  const after = parse(afterInput);
  const compatible =
    canonical(before.assembly) === canonical(after.assembly) &&
    before.producer.name === after.producer.name;
  const kinds = [
    ...new Set(
      [...before.collections, ...after.collections].map(
        (collection) => collection.kind,
      ),
    ),
  ].sort();
  const collections: RuntimeComparison["collections"] = kinds.map((kind) => {
    const left = before.collections.find(
      (collection) => collection.kind === kind,
    );
    const right = after.collections.find(
      (collection) => collection.kind === kind,
    );
    const result: RuntimeComparison["collections"][number] = {
      kind,
      status: "unverified",
      beforeCount: left?.entries.length ?? 0,
      afterCount: right?.entries.length ?? 0,
      added: 0,
      removed: 0,
      orderChanged: false,
      changedKeys: [],
    };
    if (
      !compatible ||
      !left?.complete ||
      !right?.complete ||
      left.ordered !== right.ordered
    )
      return result;
    const leftCounts = new Map<string, { key: string; count: number }>();
    const rightCounts = new Map<string, { key: string; count: number }>();
    for (const [entries, counts] of [
      [left.entries, leftCounts],
      [right.entries, rightCounts],
    ] as const)
      for (const entry of entries) {
        const id = canonical(entry);
        counts.set(id, {
          key: entry.key,
          count: (counts.get(id)?.count ?? 0) + 1,
        });
      }
    const changedKeys = new Set<string>();
    for (const id of new Set([...leftCounts.keys(), ...rightCounts.keys()])) {
      const a = leftCounts.get(id);
      const b = rightCounts.get(id);
      const change = (b?.count ?? 0) - (a?.count ?? 0);
      if (change !== 0) changedKeys.add((a ?? b)!.key);
      if (change > 0) result.added += change;
      else result.removed -= change;
    }
    result.orderChanged =
      left.ordered &&
      canonical(left.entries) !== canonical(right.entries) &&
      result.added === 0 &&
      result.removed === 0;
    result.changedKeys = [...changedKeys].sort();
    result.status =
      result.added || result.removed || result.orderChanged
        ? "changed"
        : "unchanged";
    return result;
  });
  const counts = {
    collections: collections.length,
    compared: collections.filter(
      (collection) => collection.status !== "unverified",
    ).length,
    unverified: collections.filter(
      (collection) => collection.status === "unverified",
    ).length,
    changed: collections.filter((collection) => collection.status === "changed")
      .length,
    added: collections.reduce((sum, collection) => sum + collection.added, 0),
    removed: collections.reduce(
      (sum, collection) => sum + collection.removed,
      0,
    ),
  };
  const outcome = counts.changed
    ? "failed"
    : counts.unverified
      ? "incomplete"
      : "passed";
  return {
    schemaVersion: 1,
    engineVersion: VERSION,
    provenance: "imported-runtime-comparison",
    outcome,
    reason:
      outcome === "passed"
        ? "Declared runtime collections match; imported artifacts do not attest current runtime or source freshness."
        : outcome === "failed"
          ? "Declared runtime collections changed; inspect registration counts, attributes and ordering."
          : "Runtime collection completeness or comparable assembly identity could not be established.",
    beforeFingerprint: digest(before),
    afterFingerprint: digest(after),
    counts,
    collections,
  };
}

export function projectRuntimeComparison(
  result: RuntimeComparison,
  detailed: boolean,
) {
  if (detailed) return result;
  return runtimeComparisonSummarySchema.parse({
    schemaVersion: result.schemaVersion,
    engineVersion: result.engineVersion,
    provenance: result.provenance,
    outcome: result.outcome,
    reason: result.reason,
    beforeFingerprint: result.beforeFingerprint,
    afterFingerprint: result.afterFingerprint,
    counts: result.counts,
  });
}
