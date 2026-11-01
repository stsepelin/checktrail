import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
const { captureConsumerWitnessCode, captureConsumerWitnessController } =
  await import(
    new URL("../../scripts/consumer-witness-controller.mjs", import.meta.url)
      .href
  );
test("shared controller code identity retains moved helper acceptance engine package and selected-requirements behavior", async (t) => {
  const acceptance = "dist/test/gate-context-go.test.js",
    requirements = Array.from({ length: 9 }, (_, index) => ({
      file: acceptance,
      name: "original-synthetic-case-" + index,
    }));
  const files: Record<string, string> = {
    "package.json": "{}\n",
    "scripts/required-native-tests.json": JSON.stringify({
      "context-go": requirements,
    }),
    "docs/gate-a-profiles.v1.json": JSON.stringify({
      toolVersions: { go: "1.27.1" },
    }),
    ".github/workflows/ci.yml": "original-synthetic-workflow\n",
    "dist/src/original.js": "export const original=1;\n",
  };
  for (const file of [
    "dist/test/consumer-witness-fixture.js",
    acceptance,
    "scripts/compiled-engine-evidence.mjs",
    "scripts/consumer-witness-attempts.mjs",
    "scripts/consumer-witness-jvm.mjs",
    "scripts/consumer-witness-managed.mjs",
    "scripts/consumer-witness-data.mjs",
    "scripts/consumer-witness-swift.mjs",
    "scripts/consumer-witness-project.mjs",
    "scripts/consumer-runtime-selection.mjs",
  ])
    files[file] = "export const originalSynthetic=1;\n";
  const root = await realpath(await fixture(t, files)),
    before = await captureConsumerWitnessCode(root, "go"),
    controller = await captureConsumerWitnessController(
      root,
      "go",
      {
        kind: "hosted-runner-metadata",
        imageOS: "synthetic",
        imageVersion: "synthetic",
      },
      {
        toolVersion: "go version go1.27.1 synthetic",
        hostAttestationPerformed: false,
      },
      { bytes: 32, sha256: "a".repeat(64) },
    );
  for (const field of [
    "engineSha256",
    "harnessSha256",
    "requirementsSha256",
    "acceptanceSha256",
    "packageManifestSha256",
  ]) {
    assert.equal(controller[field], before[field]);
    assert.match(before[field], /^[a-f0-9]{64}$/);
  }
  const requirementFile = path.join(root, "scripts/required-native-tests.json");
  await writeFile(
    requirementFile,
    JSON.stringify({
      "context-go": requirements,
      unselected: [{ file: "synthetic-unselected.js", name: "not selected" }],
    }),
  );
  const reduced = await captureConsumerWitnessCode(root, "go");
  assert.equal(reduced.harnessSha256, before.harnessSha256);
  assert.equal(reduced.requirementsSha256, before.requirementsSha256);
  await writeFile(
    path.join(root, "scripts/consumer-witness-project.mjs"),
    "export const originalSynthetic=2;\n",
  );
  assert.notEqual(
    (await captureConsumerWitnessCode(root, "go")).harnessSha256,
    before.harnessSha256,
  );
  const old = await readFile(path.join(root, acceptance), "utf8");
  await writeFile(
    path.join(root, acceptance),
    old + "export const editedSynthetic=1;\n",
  );
  assert.notEqual(
    (await captureConsumerWitnessCode(root, "go")).acceptanceSha256,
    before.acceptanceSha256,
  );
  await assert.rejects(captureConsumerWitnessCode(root, "unknown"));
});
