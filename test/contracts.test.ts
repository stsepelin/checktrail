import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateContracts, projectContractReport } from "../src/contracts.js";
import {
  contractReportSchema,
  contractSummarySchema,
} from "../src/contract-schema.js";
import { contractFixture } from "./contract-helpers.js";
import { fixture } from "./helpers.js";

test("consumer JSON Schema validates captured producer payloads without coercion, defaults or field removal", async () => {
  const input = contractFixture();
  const original = structuredClone(input);
  const report = await validateContracts(input);
  contractReportSchema.parse(report);
  contractSummarySchema.parse(projectContractReport(report, false));
  assert.equal(report.outcome, "passed");
  assert.equal(report.provenance, "imported-contract-samples");
  for (const payload of [
    { items: [{ id: "book", quantity: "2" }] },
    { items: [{ id: "book", quantity: -1 }] },
    { items: [{ id: "book", quantity: 1.5 }] },
    { items: [{ id: "book" }] },
    { items: [{ id: "book", quantity: 2, extra: true }] },
    { items: [] },
    { itemsExtra: [{ id: "book", quantity: 2 }] },
  ]) {
    const broken = contractFixture();
    broken.contracts[0]!.samples[0]!.payload = payload;
    const snapshot = structuredClone(broken);
    const result = await validateContracts(broken);
    assert.equal(result.outcome, "failed", JSON.stringify(payload));
    assert.equal(result.counts.rejected, 1);
    assert.ok(result.contracts[0]!.samples[0]!.errors.length > 0);
    assert.deepEqual(broken, snapshot);
  }
  assert.deepEqual(input, original);
});

test("contract validation distinguishes unsupported schemas, incomplete captures and missing samples from failures", async () => {
  for (const schema of [
    {},
    { type: "object", unknownKeyword: true },
    { type: "object", $ref: "https://example.invalid/schema.json" },
    { type: "object", $async: true },
    { type: "object", nullable: true },
    {
      type: "object",
      properties: { field: { type: "string", format: "unregistered" } },
    },
    { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
  ]) {
    const input = contractFixture();
    input.contracts[0]!.schema = schema;
    assert.equal(
      (await validateContracts(input)).outcome,
      "incomplete",
      JSON.stringify(schema),
    );
  }
  for (const patch of ["empty", "partial"]) {
    const input = contractFixture();
    if (patch === "empty") input.contracts[0]!.samples = [];
    else input.contracts[0]!.complete = false;
    assert.equal((await validateContracts(input)).outcome, "incomplete");
  }
  const mixed = contractFixture();
  mixed.contracts[0]!.samples[0]!.payload = {};
  mixed.contracts.push({
    ...structuredClone(mixed.contracts[0]!),
    id: "other",
    complete: false,
  });
  const result = await validateContracts(mixed);
  assert.equal(result.outcome, "failed");
  assert.equal(result.counts.unverified, 1);
  assert.equal(
    result.counts.passed + result.counts.failed + result.counts.unverified,
    result.counts.contracts,
  );
  assert.equal(
    result.counts.accepted + result.counts.rejected,
    result.counts.samples,
  );
});

test("schema keyword lookalikes in literal payload constraints are data and format assertions remain active", async () => {
  const input = contractFixture();
  input.contracts[0]!.schema = {
    type: "object",
    const: { $ref: "https://example.invalid/literal", $async: true },
  };
  input.contracts[0]!.samples[0]!.payload = {
    $ref: "https://example.invalid/literal",
    $async: true,
  };
  assert.equal((await validateContracts(input)).outcome, "passed");
  input.contracts[0]!.schema = { type: "string", format: "date-time" };
  input.contracts[0]!.samples[0]!.payload = "2026-09-18T00:00:00.000Z";
  assert.equal((await validateContracts(input)).outcome, "passed");
  input.contracts[0]!.samples[0]!.payload = "not-a-date";
  assert.equal((await validateContracts(input)).outcome, "failed");
});

test("contract input rejects ambiguous identities, missing payloads and invalid or excessive JSON before worker execution", async () => {
  const input = contractFixture();
  const duplicate = structuredClone(input);
  duplicate.contracts.push(structuredClone(duplicate.contracts[0]!));
  await assert.rejects(validateContracts(duplicate), /Duplicate contract/);
  const duplicateSample = structuredClone(input);
  duplicateSample.contracts[0]!.samples.push(
    structuredClone(duplicateSample.contracts[0]!.samples[0]!),
  );
  await assert.rejects(validateContracts(duplicateSample), /Duplicate sample/);
  const missing = structuredClone(input);
  missing.contracts[0]!.samples = [{ name: "absent" } as never];
  await assert.rejects(validateContracts(missing));
  for (const payload of [undefined, Number.NaN, 1n, new Date(), () => 1]) {
    const invalid = structuredClone(input);
    invalid.contracts[0]!.samples[0]!.payload = payload;
    await assert.rejects(validateContracts(invalid));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(validateContracts(cycle));
  let deep: unknown = null;
  for (let index = 0; index < 34; index++) deep = { nested: deep };
  await assert.rejects(validateContracts(deep), /structure limits/);
  await assert.rejects(
    validateContracts({ padding: "x".repeat(8 * 1024 * 1024) }),
    /8 MiB/,
  );
  for (const timeoutMs of [0, 30_001, 1.5, Number.NaN])
    await assert.rejects(validateContracts(input, { timeoutMs }));
});

test(
  "contract worker deadlines and cancellation keep pathological regular expressions off the calling event loop",
  { timeout: 10_000 },
  async (t) => {
    const input = contractFixture();
    input.contracts[0]!.schema = { type: "string", pattern: "^(a+)+$" };
    input.contracts[0]!.samples[0]!.payload = "a".repeat(1000) + "!";
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 10);
    t.after(() => clearInterval(heartbeat));
    const limited = await validateContracts(input, { timeoutMs: 500 });
    assert.equal(limited.outcome, "incomplete");
    assert.ok(ticks > 0);
    const controller = new AbortController();
    const pending = validateContracts(input, { signal: controller.signal });
    controller.abort();
    assert.equal((await pending).outcome, "incomplete");
    assert.equal(
      (await validateContracts(input, { signal: controller.signal })).outcome,
      "incomplete",
    );
    assert.equal(
      (await validateContracts(contractFixture())).outcome,
      "passed",
    );
  },
);

test("native producer serialization and consumer schema catch a cross-project type break through CLI", async (t) => {
  const input = contractFixture();
  const producer = (numeric: boolean) =>
    `export function items(){return {items:[{id:'book',quantity:${numeric ? "2" : "'2'"}}]}};`;
  const root = await fixture(t, {
    "producer/items.mjs": producer(false),
    "producer/capture.mjs":
      "import {items} from './items.mjs';process.stdout.write(JSON.stringify(items()));",
  });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const numeric of [false, true]) {
    await writeFile(path.join(root, "producer/items.mjs"), producer(numeric));
    const native = spawnSync(process.execPath, ["producer/capture.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(native.status, 0, native.stderr);
    input.contracts[0]!.samples[0]!.payload = JSON.parse(native.stdout);
    await writeFile(path.join(root, "contract.json"), JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      [cli, "check-contracts", "--root", root, "--input", "contract.json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, numeric ? 0 : 1, result.stderr);
    const report = contractSummarySchema.parse(JSON.parse(result.stdout));
    assert.equal(report.outcome, numeric ? "passed" : "failed");
    for (const hidden of [
      root,
      "book",
      "catalog-response",
      "/items",
      "quantity",
    ])
      assert.ok(!result.stdout.includes(hidden));
  }
});

test("contract workers do not inherit eval-only runtime flags from library consumers", async (t) => {
  const root = await fixture(t, {
    "contract.json": JSON.stringify(contractFixture()),
  });
  const library = new URL("../src/index.js", import.meta.url).href;
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {validateContracts} from ${JSON.stringify(library)};import {readFileSync} from 'node:fs';process.stdout.write(JSON.stringify(await validateContracts(JSON.parse(readFileSync('contract.json','utf8')))));`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).outcome, "passed");
});
