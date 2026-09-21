import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evidence.js";
import type { Check, ProcessResult } from "../src/types.js";
const fingerprint = "a".repeat(64);
const command = {
  executable: "python3",
  args: [
    "-c",
    "synthetic",
    JSON.stringify({ assembly: "sample", environment: "test" }),
    fingerprint,
  ],
  cwd: ".",
};
const check: Check = {
  id: "python.django-routes",
  adapter: "python",
  project: ".",
  scope: ["settings.py"],
  kind: "analysis",
  parser: "django-json",
  commands: [command],
  reason: "Synthetic",
};
const entry = () => {
  const patterns = [JSON.stringify(["RoutePattern", "^items/\\Z", 32, true])];
  return {
    key: JSON.stringify(patterns),
    attributes: {
      patterns,
      namespaces: [],
      handler: "urls.items",
      name: "items",
      defaultsHash: "b".repeat(64),
    },
  };
};
function evidence() {
  return {
    version: 1,
    djangoVersion: "6.1.1",
    visitedNodes: 1,
    unsupportedNodes: 0,
    runtime: {
      schemaVersion: 1,
      format: "runtime-inventory",
      producer: { name: "repo-verifier.django-routes", version: "1.0.0" },
      assembly: { name: "sample", environment: "test" },
      sourceFingerprint: fingerprint,
      capturedAt: "2026-09-18T00:00:00.000Z",
      collections: [
        { kind: "routes", complete: true, ordered: true, entries: [entry()] },
      ],
    },
  };
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

test("Django evidence preserves native matching identity and rejects contradictory or incomplete runtime capture", () => {
  assert.equal(parse(evidence()).status, "passed");
  const duplicate = evidence();
  duplicate.visitedNodes = 2;
  duplicate.runtime.collections[0]!.entries.push(entry());
  assert.equal(parse(duplicate).status, "failed");
  for (const alter of [
    (data: ReturnType<typeof evidence>) => {
      data.visitedNodes = 0;
    },
    (data: ReturnType<typeof evidence>) => {
      data.unsupportedNodes = 1;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries = [];
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.ordered = false;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.sourceFingerprint = "b".repeat(64);
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.assembly.environment = "other";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.producer.version = "2.0.0";
    },
    (data: ReturnType<typeof evidence>) => {
      data.djangoVersion = "0.0.0";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries[0]!.key += "Extra";
    },
    (data: ReturnType<typeof evidence>) => {
      const item = data.runtime.collections[0]!.entries[0]!;
      item.attributes.patterns = [
        JSON.stringify(["RoutePattern", "^items/\\Z", 32]),
      ];
      item.key = JSON.stringify(item.attributes.patterns);
    },
  ]) {
    const input = evidence();
    alter(input);
    assert.equal(parse(input).status, "inconclusive");
  }
  const partial = evidence();
  partial.visitedNodes = 2;
  partial.unsupportedNodes = 1;
  partial.runtime.collections[0]!.complete = false;
  assert.equal(parse(partial).status, "inconclusive");
  partial.runtime.collections[0]!.entries.push(entry());
  partial.visitedNodes = 3;
  assert.equal(parse(partial).status, "failed");
  for (const patch of [
    { cancelled: true },
    { timedOut: true },
    { truncated: true },
  ])
    assert.equal(parse(evidence(), patch).status, "inconclusive");
  for (const reason of ["missing-package", "unsupported-version"])
    assert.equal(
      parse({ unavailable: "django-runtime", reason }, { exitCode: 3 }).status,
      "unavailable",
    );
  assert.equal(parse({}, { exitCode: 2 }).status, "error");
});
