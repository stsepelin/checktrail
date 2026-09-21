import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
import type { RuntimeInventory } from "../src/runtime-inventory.js";
const fingerprint = "a".repeat(64);
const command = {
  executable: "php",
  args: [
    "-r",
    "synthetic",
    "vendor/autoload.php",
    JSON.stringify({
      schemaVersion: 1,
      assembly: "sample",
      environment: "testing",
    }),
    fingerprint,
  ],
  cwd: ".",
};
const check: Check = {
  id: "php.laravel-runtime",
  adapter: "php",
  project: ".",
  scope: ["bootstrap/app.php"],
  kind: "analysis",
  parser: "laravel-json",
  commands: [command],
  reason: "Synthetic",
};
function evidence() {
  const runtime: RuntimeInventory = {
    schemaVersion: 1,
    format: "runtime-inventory",
    producer: { name: "checktrail.laravel-runtime", version: "1.0.0" },
    assembly: { name: "sample", environment: "testing" },
    sourceFingerprint: fingerprint,
    capturedAt: "2026-09-18T00:00:00Z",
    collections: [
      {
        kind: "routes",
        ordered: true,
        complete: true,
        entries: [
          {
            key: '[null,"GET","catalog"]',
            attributes: {
              domain: null,
              method: "GET",
              uri: "catalog",
              name: "catalog",
              handler: "CatalogController@show",
              middleware: ["SyntheticAuth"],
              constraintsHash: fingerprint,
              defaultsHash: fingerprint,
            },
          },
        ],
      },
      {
        kind: "middleware",
        ordered: true,
        complete: true,
        entries: [
          { key: "global", attributes: { type: "global", stack: [] } },
          { key: "priority", attributes: { type: "priority", stack: [] } },
        ],
      },
      { kind: "listeners", ordered: true, complete: true, entries: [] },
      { kind: "schedules", ordered: true, complete: true, entries: [] },
      {
        kind: "bindings",
        ordered: false,
        complete: true,
        entries: [
          {
            key: "factory:catalog",
            attributes: {
              type: "factory",
              abstract: "catalog",
              target: "CatalogService",
              shared: true,
              scoped: false,
            },
          },
        ],
      },
    ],
  };
  return { version: 1, laravelVersion: "13.32.0", entryCount: 4, runtime };
}
const parse = (data: unknown, patch: Partial<ProcessResult> = {}) =>
  evaluate(check, [
    {
      command,
      stdout: JSON.stringify(data),
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      truncated: false,
      cancelled: false,
      ...patch,
    },
  ]);

test("Laravel evidence requires every declared collection, identity, accounting and complete attribute projection", () => {
  assert.equal(parse(evidence()).status, "passed");
  for (const alter of [
    (data: ReturnType<typeof evidence>) => {
      data.entryCount = 0;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections.pop();
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[4]!.kind = "listeners";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.ordered = false;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[4]!.complete = false;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries = [];
      data.entryCount--;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[1]!.entries.pop();
      data.entryCount--;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries[0]!.key =
        '[null,"GET","catalog-extra"]';
    },
    (data: ReturnType<typeof evidence>) => {
      delete data.runtime.collections[0]!.entries[0]!.attributes.middleware;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[4]!.entries[0]!.attributes.shared = "false";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[4]!.entries[0]!.key += "-extra";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.sourceFingerprint = "b".repeat(64);
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.assembly.environment = "production";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.producer.version = "2.0.0";
    },
    (data: ReturnType<typeof evidence>) => {
      data.laravelVersion = "13.31.0";
    },
  ]) {
    const data = evidence();
    alter(data);
    assert.equal(parse(data).status, "inconclusive");
  }
  for (const patch of [
    { truncated: true },
    { timedOut: true },
    { cancelled: true },
  ])
    assert.equal(parse(evidence(), patch).status, "inconclusive");
  assert.equal(parse({}, { exitCode: 2 }).status, "error");
  assert.equal(
    parse(
      { unavailable: "laravel-runtime", reason: "unsupported-version" },
      { exitCode: 3 },
    ).status,
    "unavailable",
  );
});
