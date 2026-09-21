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
  id: "python.fastapi-routes",
  adapter: "python",
  project: ".",
  scope: ["app.py"],
  kind: "analysis",
  parser: "fastapi-json",
  commands: [command],
  reason: "Synthetic",
};
const entry = (method: string, path = "/items") => ({
  key: `HTTP ${method} ${path}`,
  attributes: {
    protocol: "http",
    method,
    path,
    handler: "app.items",
    name: "items",
    dependencies: [],
    includeInSchema: true,
  },
});
function evidence() {
  return {
    version: 1,
    versions: { fastapi: "0.141.1", starlette: "1.6.0" },
    totalRoutes: 2,
    supportedRoutes: 2,
    applicationRoutes: 2,
    entryRouteIndices: [0, 1],
    runtime: {
      schemaVersion: 1,
      format: "runtime-inventory",
      producer: { name: "checktrail.fastapi-routes", version: "1.0.0" },
      assembly: { name: "sample", environment: "test" },
      sourceFingerprint: fingerprint,
      capturedAt: "2026-09-18T00:00:00.000Z",
      collections: [
        {
          kind: "routes",
          complete: true,
          ordered: true,
          entries: [entry("GET"), entry("POST")],
        },
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

test("FastAPI evidence reconciles native registration accounting and preserves protocol/method boundaries", () => {
  assert.equal(parse(evidence()).status, "passed");
  const duplicate = evidence();
  duplicate.runtime.collections[0]!.entries[1] = entry("GET");
  assert.equal(parse(duplicate).status, "failed");
  for (const alter of [
    (data: ReturnType<typeof evidence>) => {
      data.applicationRoutes = 0;
    },
    (data: ReturnType<typeof evidence>) => {
      data.entryRouteIndices = [0, 0];
    },
    (data: ReturnType<typeof evidence>) => {
      data.entryRouteIndices = [1, 0];
    },
    (data: ReturnType<typeof evidence>) => {
      data.entryRouteIndices = [0, 2];
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.sourceFingerprint = "b".repeat(64);
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.assembly.environment = "other";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.producer.name = "other";
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries.pop();
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.ordered = false;
    },
    (data: ReturnType<typeof evidence>) => {
      data.runtime.collections[0]!.entries[0]!.key = "HTTP GET /items-extra";
    },
    (data: ReturnType<typeof evidence>) => {
      data.versions.fastapi = "0.0.0";
    },
  ]) {
    const data = evidence();
    alter(data);
    assert.equal(parse(data).status, "inconclusive");
  }
  const partial = evidence();
  partial.totalRoutes = 3;
  partial.runtime.collections[0]!.complete = false;
  assert.equal(parse(partial).status, "inconclusive");
  partial.runtime.collections[0]!.entries[1] = entry("GET");
  assert.equal(parse(partial).status, "failed");
  for (const patch of [
    { cancelled: true },
    { timedOut: true },
    { truncated: true },
  ])
    assert.equal(parse(evidence(), patch).status, "inconclusive");
  for (const reason of ["missing-package", "unsupported-version"])
    assert.equal(
      parse({ unavailable: "fastapi-runtime", reason }, { exitCode: 3 }).status,
      "unavailable",
    );
  assert.equal(
    parse(
      { unavailable: "fastapi-runtime", reason: "unknown" },
      { exitCode: 3 },
    ).status,
    "inconclusive",
  );
  assert.equal(parse({}, { exitCode: 2 }).status, "error");
});
