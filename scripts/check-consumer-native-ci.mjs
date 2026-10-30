import assert from "node:assert/strict";
import process from "node:process";
import { readFile, realpath, appendFile } from "node:fs/promises";
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
} from "./consumer-native-acceptance-capsule.mjs";
import { readConsumerNativeCapsuleArtifacts } from "./consumer-native-ci-artifacts.mjs";
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
  plan = JSON.parse(process.env.CHECKTRAIL_CI_PLAN),
  scopes = consumerNativeAcceptanceScopes(manifest, inventory, profiles),
  selected = scopes.filter(
    (scope) => plan.selected[consumerNativeScopeJob(scope)],
  );
if (process.argv.length === 3 && process.argv[2] === "--selection") {
  assert.ok(process.env.GITHUB_OUTPUT);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    "selected=" + (selected.length > 0 ? "true" : "false") + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      selectedScopes: selected.map((scope) => scope.id),
      allDeclaredScopes: scopes.length,
      consumerProfileComplete: false,
    }) + "\n",
  );
} else {
  assert.equal(process.argv.length, 2);
  const ci = consumerNativeCIRunObservation(),
    needs = JSON.parse(process.env.CHECKTRAIL_CI_NEEDS);
  assert.equal(ci.kind, "github-actions-run-metadata");
  const capsules = selected.length
      ? await readConsumerNativeCapsuleArtifacts(
          process.env.CHECKTRAIL_NATIVE_CAPSULE_ARTIFACTS,
          selected,
          ci.runAttempt,
        )
      : [],
    source = await captureConsumerNativeSourceFrame(root),
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
