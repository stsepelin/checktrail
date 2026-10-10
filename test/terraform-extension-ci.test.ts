import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
test("Terraform extension CI phases preserve finite source installed and paired guard inventories", async () => {
  const root = new URL("../../", import.meta.url),
    ci = parse(
      await readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    );
  const job = ci.jobs["terraform-extensions-arm64"];
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.strategy.matrix.phase, [
    "baseline",
    "acceptance",
    "guards-1",
    "guards-2",
  ]);
  assert.equal(job["runs-on"], "ubuntu-24.04-arm");
  assert.equal(job["timeout-minutes"], 45);
  assert.ok(
    job.steps.some(
      (s: { run?: string }) =>
        s.run ===
        "node scripts/verify-terraform-extensions-container.mjs ${{ matrix.phase }}",
    ),
  );
  assert.ok(
    job.steps.some(
      (s: { run?: string }) =>
        s.run === "node scripts/prepare-terraform-extensions-runtime.mjs",
    ),
  );
  const profiles = JSON.parse(
      await readFile(
        new URL("scripts/required-native-tests.json", root),
        "utf8",
      ),
    ),
    inventory = JSON.parse(
      await readFile(new URL("docs/gate-a-profiles.v1.json", root), "utf8"),
    );
  const planned = inventory.extensionProfiles.find(
    (p: { id: string }) => p.id === "terraform-extensions",
  );
  const expected = planned.acceptanceCases.map(
    (c: { id: string; name: string }) => ({
      file:
        c.id === "privacy"
          ? "dist/test/terraform-extensions-surfaces.test.js"
          : c.id === "lifecycle"
            ? "dist/test/terraform-extensions-lifecycle.test.js"
            : planned.acceptanceFile,
      name: c.name,
    }),
  );
  const diagnostic = {
    file: planned.acceptanceFile,
    name: "terraform-extensions diagnostic acceptance",
  };
  const key = (v: unknown) => JSON.stringify(v);
  assert.deepEqual(
    profiles["terraform-extensions"].map(key).toSorted(),
    [...expected, diagnostic].map(key).toSorted(),
  );
  const controls = JSON.parse(
    await readFile(
      new URL("scripts/terraform-extensions-controls.json", root),
      "utf8",
    ),
  );
  assert.equal(
    new Set(controls.map((c: { id: string }) => c.id)).size,
    controls.length,
  );
  const shards = [
    controls.filter((_: unknown, i: number) => i % 2 === 0),
    controls.filter((_: unknown, i: number) => i % 2 === 1),
  ];
  assert.equal(shards[0]!.length + shards[1]!.length, controls.length);
  assert.deepEqual(
    shards
      .flat()
      .map((c: { id: string }) => c.id)
      .toSorted(),
    controls.map((c: { id: string }) => c.id).toSorted(),
  );
  assert.deepEqual(
    controls
      .filter((c: { nativeInvocation?: boolean }) => c.nativeInvocation)
      .map((c: { id: string }) => c.id),
    ["native-input-flag-selection"],
  );
});
