import assert from "node:assert/strict";
import { test } from "node:test";
const {
  validateConsumerNativeSourceFrame,
  requireConsumerNativeSourceFrame,
  consumerNativeCIRunObservation,
} = await import(
  new URL("../../scripts/consumer-native-acceptance-frame.mjs", import.meta.url)
    .href
);
const frame = () => ({
  schemaVersion: 1,
  profile: "native-consumer-current-source-frame-v1",
  commit: "a".repeat(40),
  gitTree: "b".repeat(40),
  sourceManifestSha256: "1".repeat(64),
  engineSha256: "2".repeat(64),
  engineManifestSha256: "3".repeat(64),
  harnessSha256: "9".repeat(64),
  harnessManifestSha256: "a".repeat(64),
  inventorySha256: "4".repeat(64),
  inventoryScopeSha256: "5".repeat(64),
  requirementsSha256: "6".repeat(64),
  packageManifestSha256: "7".repeat(64),
  packageLockSha256: "8".repeat(64),
  sourceFiles: 1,
  sourceBytes: 1,
  clean: true,
  hostAttestationPerformed: false,
  gateAComplete: false,
});
test("native matrix source frames retain every current source engine inventory package and harness boundary without accepting a stale neighboring scope", () => {
  const expected = frame();
  assert.deepEqual(validateConsumerNativeSourceFrame(expected), expected);
  assert.deepEqual(
    requireConsumerNativeSourceFrame(structuredClone(expected), expected),
    expected,
  );
  for (const field of [
    "sourceManifestSha256",
    "engineSha256",
    "engineManifestSha256",
    "harnessSha256",
    "harnessManifestSha256",
    "inventorySha256",
    "inventoryScopeSha256",
    "requirementsSha256",
    "packageManifestSha256",
    "packageLockSha256",
  ] as const) {
    const changed = { ...expected, [field]: "f".repeat(64) };
    assert.throws(
      () => requireConsumerNativeSourceFrame(changed, expected),
      /another source/,
    );
  }
  for (const changed of [
    { ...expected, commit: "f".repeat(40) },
    { ...expected, gitTree: "f".repeat(40) },
    { ...expected, clean: false },
    { ...expected, sourceFiles: 0 },
    { ...expected, sourceBytes: 0 },
    { ...expected, hostAttestationPerformed: true },
    { ...expected, gateAComplete: true },
  ])
    assert.throws(() => requireConsumerNativeSourceFrame(changed, expected));
});
test("CI run identity is explicitly observed metadata and requires exact complete run attempt and job identifiers", () => {
  assert.deepEqual(consumerNativeCIRunObservation({}), {
    kind: "local-operator-metadata",
    runId: null,
    runAttempt: null,
    job: null,
    metadataAttested: false,
  });
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_JOB: "tasks-runtime",
  };
  assert.deepEqual(consumerNativeCIRunObservation(environment), {
    kind: "github-actions-run-metadata",
    runId: "123",
    runAttempt: "2",
    job: "tasks-runtime",
    metadataAttested: false,
  });
  for (const changed of [
    { ...environment, GITHUB_RUN_ID: "" },
    { ...environment, GITHUB_RUN_ID: "123-extra" },
    { ...environment, GITHUB_RUN_ATTEMPT: "0" },
    { ...environment, GITHUB_JOB: "tasks/runtime" },
  ])
    assert.throws(() => consumerNativeCIRunObservation(changed));
});

test("current native source frame reads an actual clean synthetic Git tree and refuses dirty untracked or changed compiled bytes", async (t) => {
  const { captureConsumerNativeSourceFrame } = await import(
    new URL(
      "../../scripts/consumer-native-acceptance-frame.mjs",
      import.meta.url,
    ).href
  );
  const { fixture } = await import("./helpers.js");
  const { fixtureGit } = await import("./git-fixture.js");
  const { realpath, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const original = "export const original = 1;\n";
  const root = await realpath(
    await fixture(t, {
      ".gitignore": "dist/\n",
      "src/original.ts": original,
      "dist/src/original.js": original,
      "dist/test/original.test.js": original,
      "docs/gate-a-profiles.v1.json": JSON.stringify({
        scopeSha256: "a".repeat(64),
      }),
      "scripts/required-native-tests.json": "{}\n",
      "package.json": "{}\n",
      "package-lock.json": "{}\n",
    }),
  );
  fixtureGit(root, ["init", "--quiet"]);
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, [
    "-c",
    "user.name=Original Synthetic",
    "-c",
    "user.email=original@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Original synthetic source",
  ]);
  const before = await captureConsumerNativeSourceFrame(root);
  assert.equal(before.commit, fixtureGit(root, ["rev-parse", "HEAD"]).trim());
  assert.equal(before.clean, true);
  assert.equal(
    before.sourceFiles,
    fixtureGit(root, ["ls-files", "-z"]).split("\0").filter(Boolean).length,
  );
  await writeFile(
    path.join(root, "src/original.ts"),
    "export const changed = 2;\n",
  );
  await assert.rejects(
    captureConsumerNativeSourceFrame(root),
    /clean current source/,
  );
  await writeFile(path.join(root, "src/original.ts"), original);
  await writeFile(
    path.join(root, "untracked.txt"),
    "synthetic additional source\n",
  );
  await assert.rejects(
    captureConsumerNativeSourceFrame(root),
    /clean current source/,
  );
  await rm(path.join(root, "untracked.txt"));
  await writeFile(
    path.join(root, "dist/src/original.js"),
    "export const changed = 2;\n",
  );
  const changed = await captureConsumerNativeSourceFrame(root);
  assert.equal(changed.commit, before.commit);
  assert.equal(changed.sourceManifestSha256, before.sourceManifestSha256);
  assert.notEqual(changed.engineSha256, before.engineSha256);
  assert.throws(
    () => requireConsumerNativeSourceFrame(changed, before),
    /another source/,
  );
  await writeFile(path.join(root, "dist/src/original.js"), original);
  await writeFile(
    path.join(root, "dist/test/original.test.js"),
    "export const changedHarness = 2;\n",
  );
  const changedHarness = await captureConsumerNativeSourceFrame(root);
  assert.equal(changedHarness.engineSha256, before.engineSha256);
  assert.notEqual(changedHarness.harnessSha256, before.harnessSha256);
  assert.throws(
    () => requireConsumerNativeSourceFrame(changedHarness, before),
    /another source/,
  );
  await writeFile(path.join(root, "dist/test/original.test.js"), original);
  assert.deepEqual(await captureConsumerNativeSourceFrame(root), before);
});
