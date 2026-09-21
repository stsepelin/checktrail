import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareRuntimeInventories,
  projectRuntimeComparison,
  runtimeComparisonSchema,
  runtimeComparisonSummarySchema,
  type RuntimeInventory,
} from "../src/runtime-inventory.js";
import { fixture } from "./helpers.js";

export function runtimeFixture(): RuntimeInventory {
  return {
    schemaVersion: 1,
    format: "runtime-inventory",
    producer: { name: "synthetic-runtime", version: "1.0.0" },
    assembly: { name: "synthetic-service", environment: "isolated-test" },
    sourceFingerprint: "a".repeat(64),
    capturedAt: "2026-09-18T00:00:00.000Z",
    collections: [
      {
        kind: "routes",
        complete: true,
        ordered: true,
        entries: [
          {
            key: "GET /items",
            attributes: {
              middleware: ["authenticate", "authorize"],
              handler: "listItems",
            },
          },
        ],
      },
      {
        kind: "listeners",
        complete: true,
        ordered: true,
        entries: [
          { key: "ItemCreated", attributes: { listener: "NotifyOwner" } },
        ],
      },
      {
        kind: "middleware",
        complete: true,
        ordered: true,
        entries: [
          {
            key: "global",
            attributes: { handlers: ["session", "authenticate"] },
          },
        ],
      },
      {
        kind: "schedules",
        complete: true,
        ordered: false,
        entries: [
          {
            key: "refresh-index",
            attributes: { expression: "0 * * * *", overlap: false },
          },
        ],
      },
      {
        kind: "bindings",
        complete: true,
        ordered: false,
        entries: [
          {
            key: "Catalog",
            attributes: { implementation: "LocalCatalog", singleton: true },
          },
        ],
      },
    ],
  };
}

test("runtime comparison detects each assembly family, exact identifiers, attributes and duplicate registrations", () => {
  const before = runtimeFixture();
  const unchanged = compareRuntimeInventories(before, structuredClone(before));
  runtimeComparisonSchema.parse(unchanged);
  runtimeComparisonSummarySchema.parse(
    projectRuntimeComparison(unchanged, false),
  );
  assert.equal(unchanged.outcome, "passed");
  assert.equal(unchanged.counts.compared, 5);
  for (let index = 0; index < before.collections.length; index++) {
    for (const operation of [
      "duplicate",
      "remove",
      "rename",
      "attribute",
    ] as const) {
      const after = structuredClone(before);
      const collection = after.collections[index]!;
      if (operation === "duplicate")
        collection.entries.push(structuredClone(collection.entries[0]!));
      if (operation === "remove") collection.entries = [];
      if (operation === "rename") collection.entries[0]!.key += "Extra";
      if (operation === "attribute")
        collection.entries[0]!.attributes.extra = true;
      const result = compareRuntimeInventories(before, after);
      assert.equal(result.outcome, "failed", `${collection.kind}/${operation}`);
      assert.equal(result.counts.changed, 1);
      assert.equal(result.counts.added, operation === "remove" ? 0 : 1);
      assert.equal(result.counts.removed, operation === "duplicate" ? 0 : 1);
      assert.equal(
        result.counts.compared + result.counts.unverified,
        result.counts.collections,
      );
    }
  }
  const attributes = structuredClone(before);
  attributes.collections[0]!.entries[0]!.attributes.middleware = [
    "authorize",
    "authenticate",
  ];
  assert.equal(compareRuntimeInventories(before, attributes).outcome, "failed");
  const reorderedProperties = structuredClone(before);
  reorderedProperties.collections[0]!.entries[0]!.attributes = {
    handler: "listItems",
    middleware: ["authenticate", "authorize"],
  };
  reorderedProperties.collections.reverse();
  reorderedProperties.sourceFingerprint = "b".repeat(64);
  reorderedProperties.producer.version = "1.1.0";
  assert.equal(
    compareRuntimeInventories(before, reorderedProperties).outcome,
    "passed",
  );
});

test("runtime comparison respects order only for declared ordered collections and never erases duplicates", () => {
  const before = runtimeFixture();
  before.collections[0]!.entries.push({
    key: "GET /items/new",
    attributes: { handler: "newItem" },
  });
  const after = structuredClone(before);
  after.collections[0]!.entries.reverse();
  const result = compareRuntimeInventories(before, after);
  assert.equal(result.outcome, "failed");
  assert.equal(
    result.collections.find((item) => item.kind === "routes")!.orderChanged,
    true,
  );
  assert.equal(result.counts.added, 0);
  assert.equal(result.counts.removed, 0);
  before.collections[0]!.ordered = false;
  after.collections[0]!.ordered = false;
  assert.equal(compareRuntimeInventories(before, after).outcome, "passed");
  after.collections[0]!.entries.push(
    structuredClone(after.collections[0]!.entries[0]!),
  );
  assert.equal(compareRuntimeInventories(before, after).counts.added, 1);
});

test("runtime comparison rejects malformed profiles and distinguishes absent or incomplete collections from empty ones", () => {
  const before = runtimeFixture();
  for (const patch of [
    (after: RuntimeInventory) => {
      after.collections[0]!.complete = false;
      after.collections[0]!.entries = [];
    },
    (after: RuntimeInventory) => {
      after.collections.shift();
    },
    (after: RuntimeInventory) => {
      after.collections[0]!.ordered = false;
    },
    (after: RuntimeInventory) => {
      after.assembly.environment = "other";
    },
    (after: RuntimeInventory) => {
      after.assembly.name = "other";
    },
    (after: RuntimeInventory) => {
      after.producer.name = "other";
    },
  ]) {
    const after = structuredClone(before);
    patch(after);
    const result = compareRuntimeInventories(before, after);
    assert.equal(result.outcome, "incomplete");
    assert.equal(result.counts.removed, 0);
    assert.ok(result.counts.unverified > 0);
  }
  const partial = structuredClone(before);
  partial.collections[0]!.complete = false;
  partial.collections[1]!.entries = [];
  const mixed = compareRuntimeInventories(before, partial);
  assert.equal(mixed.outcome, "failed");
  assert.equal(mixed.counts.unverified, 1);
  const empty = structuredClone(before);
  for (const collection of empty.collections) collection.entries = [];
  assert.equal(compareRuntimeInventories(empty, empty).outcome, "passed");
  for (const bad of [
    { ...before, collections: [] },
    { ...before, collections: [before.collections[0], before.collections[0]] },
    { ...before, sourceFingerprint: "unknown" },
    { ...before, trusted: true },
    {
      ...before,
      collections: [
        {
          ...before.collections[0],
          entries: [{ key: "value", attributes: { nested: {} } }],
        },
      ],
    },
  ])
    assert.throws(() => compareRuntimeInventories(before, bad));
  assert.throws(() =>
    compareRuntimeInventories(before, {
      ...before,
      padding: "x".repeat(8 * 1024 * 1024),
    }),
  );
});

test("runtime CLI compares imported artifacts without execution and hides assembly identifiers by default", async (t) => {
  const before = runtimeFixture();
  const after = structuredClone(before);
  after.collections[1]!.entries.push(
    structuredClone(after.collections[1]!.entries[0]!),
  );
  const root = await fixture(t, {
    "before.json": JSON.stringify(before),
    "after.json": JSON.stringify(after),
  });
  const binary = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      binary,
      "compare-runtime",
      "--root",
      root,
      "--before",
      "before.json",
      "--after",
      "after.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 1, run.stderr);
  const result = runtimeComparisonSummarySchema.parse(JSON.parse(run.stdout));
  assert.equal(result.provenance, "imported-runtime-comparison");
  assert.equal(result.counts.added, 1);
  for (const hidden of [
    root,
    "NotifyOwner",
    "ItemCreated",
    "synthetic-service",
  ])
    assert.ok(!run.stdout.includes(hidden));
  const escaped = spawnSync(
    process.execPath,
    [
      binary,
      "compare-runtime",
      "--root",
      root,
      "--before",
      "../outside.json",
      "--after",
      "after.json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(escaped.status, 2);
});
