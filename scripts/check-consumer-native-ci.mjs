import assert from "node:assert/strict";
import process from "node:process";
import { readFile, readdir, realpath, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { consumerNativeAcceptanceScopes } from "./consumer-native-acceptance-scope.mjs";
import {
  captureConsumerNativeSourceFrame,
  consumerNativeCIRunObservation,
} from "./consumer-native-acceptance-frame.mjs";
import {
  aggregateConsumerNativeCapsules,
  consumerNativeScopeJob,
  consumerNativeScopeLane,
  consumerNativeCapsuleFilename,
  validateConsumerNativeCapsule,
  selectConsumerNativeProducerClaims,
} from "./consumer-native-acceptance-capsule.mjs";
import {
  createConsumerNativeJobFinish,
  requireConsumerNativeProducerClaims,
  writeConsumerNativeJobOutput,
} from "./consumer-native-job-claims.mjs";
import {
  requireConsumerPrivateDirectory,
  readConsumerPrivateFile,
} from "./consumer-native-host-storage.mjs";
import {
  consumerNativeCIDirectory,
  readConsumerNativeCapsuleArtifacts,
} from "./consumer-native-ci-artifacts.mjs";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  [manifest, inventory, profiles] = await Promise.all(
    [
      "docs/gate-a-consumer-witnesses.v1.json",
      "docs/gate-a-profiles.v1.json",
      "scripts/required-native-tests.json",
    ].map(async (file) =>
      JSON.parse(await readFile(path.join(root, file), "utf8")),
    ),
  ),
  scopes = consumerNativeAcceptanceScopes(manifest, inventory, profiles),
  ci = consumerNativeCIRunObservation();
assert.equal(ci.kind, "github-actions-run-metadata");
if (process.argv.length === 4 && process.argv[2] === "--publish") {
  const lane = process.argv[3],
    selected = scopes.filter(
      (scope) =>
        consumerNativeScopeJob(scope) === ci.job &&
        consumerNativeScopeLane(scope) === lane,
    );
  assert.ok(selected.length > 0 && selected.length <= 2);
  const source = await captureConsumerNativeSourceFrame(root),
    start = JSON.parse(process.env.CHECKTRAIL_NATIVE_JOB_START);
  assert.equal(
    start.runAttempt,
    ci.runAttempt,
    "New publisher cannot reuse an earlier job START",
  );
  const directory = consumerNativeCIDirectory(
    process.env.CHECKTRAIL_NATIVE_CAPSULE_DIRECTORY,
  );
  await requireConsumerPrivateDirectory(directory);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    selected.map(consumerNativeCapsuleFilename).sort(),
  );
  const capsules = [];
  for (const scope of selected) {
    const raw = await readConsumerPrivateFile(
        path.join(directory, consumerNativeCapsuleFilename(scope)),
        1048576,
      ),
      capsule = JSON.parse(raw.bytes.toString("utf8"));
    assert.equal(JSON.stringify(capsule) + "\n", raw.bytes.toString("utf8"));
    validateConsumerNativeCapsule(capsule, scope, source);
    capsules.push(capsule);
  }
  const artifact = {
      id: process.env.CHECKTRAIL_NATIVE_ARTIFACT_ID,
      name: process.env.CHECKTRAIL_NATIVE_ARTIFACT_NAME,
      digest: process.env.CHECKTRAIL_NATIVE_ARTIFACT_DIGEST,
    },
    finish = createConsumerNativeJobFinish(start, source, capsules, artifact);
  requireConsumerNativeProducerClaims(start, finish, {
    ci,
    source,
    job: ci.job,
    lane,
    scopes: selected,
  });
  await writeConsumerNativeJobOutput("finish", finish);
  process.stdout.write(
    JSON.stringify({
      job: ci.job,
      lane,
      producerAttempt: start.runAttempt,
      artifactId: artifact.id,
      scopeIds: selected.map((scope) => scope.id),
      metadataAttested: false,
      gateAComplete: false,
    }) + "\n",
  );
} else {
  const selection =
    process.argv.length === 3 && process.argv[2] === "--selection";
  assert.ok(selection || process.argv.length === 2);
  const plan = JSON.parse(process.env.CHECKTRAIL_CI_PLAN),
    needs = JSON.parse(process.env.CHECKTRAIL_CI_NEEDS),
    source = await captureConsumerNativeSourceFrame(root),
    selected = scopes.filter(
      (scope) => plan.selected[consumerNativeScopeJob(scope)] === true,
    ),
    bindings = selectConsumerNativeProducerClaims({
      scopes,
      selectedJobs: plan.selected,
      completedJobs: needs,
      source,
      ci,
    });
  if (selection) {
    assert.ok(process.env.GITHUB_OUTPUT);
    await appendFile(
      process.env.GITHUB_OUTPUT,
      "selected=" +
        (selected.length > 0 ? "true" : "false") +
        "\nartifact_ids=" +
        bindings.map((row) => row.finish.artifact.id).join(",") +
        "\n",
    );
    process.stdout.write(
      JSON.stringify({
        selectedScopes: selected.map((scope) => scope.id),
        producerArtifacts: bindings.map((row) => ({
          job: row.job,
          lane: row.lane,
          producerAttempt: row.start.runAttempt,
          ...row.finish.artifact,
        })),
        allDeclaredScopes: scopes.length,
        consumerProfileComplete: false,
      }) + "\n",
    );
  } else {
    const capsules = selected.length
        ? await readConsumerNativeCapsuleArtifacts(
            consumerNativeCIDirectory(
              process.env.CHECKTRAIL_NATIVE_CAPSULE_ARTIFACTS,
            ),
            selected,
            bindings,
          )
        : [],
      report = aggregateConsumerNativeCapsules({
        manifest,
        inventory,
        profiles,
        source,
        capsules,
        selectedJobs: plan.selected,
        completedJobs: needs,
        ci,
      });
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}
