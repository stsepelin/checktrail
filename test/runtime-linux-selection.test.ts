import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const script = (name: string) =>
  import(new URL("../../scripts/" + name + ".mjs", import.meta.url).href);
const review = await script("review-runtime-evidence");
const evaluation = await script("evaluation-runtime-evidence");
const attempt = await script("attempt-runtime-evidence");
const consumer = await script("consumer-runtime-selection");
const tasks = await script("tasks-runtime-evidence");
const scope = JSON.parse(
  await readFile(
    new URL("../../docs/gate-a-profiles.v1.json", import.meta.url),
    "utf8",
  ),
);
const checks = [
  ["review", review.checkReviewRuntimeSelection],
  ["evaluation", evaluation.checkEvaluationRuntimeSelection],
  ["attempt", attempt.checkAttemptRuntimeSelection],
  ["consumer", consumer.checkConsumerRuntimeSelection],
] as const;
type Profile = {
  id: string;
  node: string;
  platform: string;
  architecture: string;
};
const sha = "a".repeat(64);
function observed(profile: Profile, name: string) {
  const container = profile.architecture === "arm64";
  return {
    slot: profile.id,
    node: profile.node,
    platform: profile.platform,
    architecture: profile.architecture,
    distributionId: container ? "alpine" : "ubuntu",
    distributionVersion: container ? "synthetic-container-release" : "26.04",
    imageOS: container ? null : "ubuntu26",
    imageVersion: container ? null : "20261111.196.1",
    containerReference:
      name === "evaluation"
        ? consumer.consumerRuntimeBaseImages.node
        : "sha256:" + sha,
    containerImageId: "sha256:" + sha,
    baseNodeReference: consumer.consumerRuntimeBaseImages.node,
    baseSystemReference: consumer.consumerRuntimeBaseImages.system,
    containerDefinitionSha256: sha,
    gitExecutableSha256: sha,
    gitVersion: "git version 2.56.0",
    goVersion: "go1.27.1",
    goExecutableSha256: sha,
    goPlatform: "linux",
    goArchitecture: profile.architecture === "x64" ? "amd64" : "arm64",
  };
}

test("every current Linux host selector accepts Ubuntu 26 and rejects stale mixed and near-miss image identities", () => {
  const hosts = scope.runtimeProfiles.filter(
    (p: Profile) => p.platform === "linux" && p.architecture === "x64",
  );
  assert.equal(hosts.length, 3);
  for (const profile of hosts) {
    for (const [name, check] of checks) {
      const value = observed(profile, name);
      assert.equal(check(scope, profile.id, value, true), profile, name);
      for (const change of [
        { distributionVersion: "24.04", imageOS: "ubuntu24" },
        { distributionVersion: "24.04" },
        { imageOS: "ubuntu24" },
        { imageOS: "ubuntu26-arm64" },
        { imageOS: "ubuntu26-extra" },
        { imageOS: "prefix-ubuntu26" },
        { imageOS: null },
        { distributionVersion: "26.040" },
        { distributionId: "debian" },
      ])
        assert.throws(
          () => check(scope, profile.id, { ...value, ...change }, true),
          { code: "ERR_ASSERTION" },
          name + ": " + JSON.stringify(change),
        );
      for (const [key, changedValue] of [
        ["osFamily", "Ubuntu 24.04"],
        ["osFamily", "Ubuntu 26.04-extra"],
        ["osFamily", "constructor"],
        ["runnerLabel", "ubuntu-24.04"],
        ["runnerLabel", "ubuntu-26.04-arm"],
      ]) {
        const changed = structuredClone(scope);
        changed.runtimeProfiles.find((p: Profile) => p.id === profile.id)[
          key!
        ] = changedValue;
        assert.throws(
          () => check(changed, profile.id, value, true),
          { code: "ERR_ASSERTION" },
          name + ": selected " + key,
        );
      }
    }
  }
});

test("the native ARM container keeps its pinned image boundary independently of the Ubuntu runner host", () => {
  const profile = scope.runtimeProfiles.find(
    (p: Profile) => p.id === "native-linux-arm64-node22",
  );
  assert.equal(profile.osFamily, undefined);
  assert.equal(profile.hostOsFamily, "Ubuntu 26.04");
  assert.equal(profile.runnerLabel, "ubuntu-26.04-arm");
  for (const [name, check] of checks) {
    const value = observed(profile, name);
    assert.equal(check(scope, profile.id, value, false), profile, name);
    assert.throws(
      () =>
        check(scope, profile.id, { ...value, containerImageId: null }, false),
      name,
    );
    if (name === "evaluation")
      assert.throws(() =>
        check(
          scope,
          profile.id,
          { ...value, containerReference: "docker.io/library/node:latest" },
          false,
        ),
      );
    if (name === "consumer" || name === "attempt")
      assert.throws(() =>
        check(
          scope,
          profile.id,
          { ...value, baseNodeReference: "docker.io/library/node:latest" },
          false,
        ),
      );
  }
});

test("Tasks hosted image admission distinguishes x64 and ARM placement without treating it as container distribution", () => {
  for (const profile of scope.runtimeProfiles.filter(
    (p: Profile) => p.platform === "linux",
  )) {
    const image =
      profile.architecture === "arm64" ? "ubuntu26-arm64" : "ubuntu26";
    tasks.checkTasksHostedLinuxImage(profile, image);
    for (const changed of [
      "ubuntu24",
      "ubuntu24-arm64",
      image + "-extra",
      "prefix-" + image,
      null,
    ])
      assert.throws(() => tasks.checkTasksHostedLinuxImage(profile, changed));
    assert.throws(() =>
      tasks.checkTasksHostedLinuxImage(
        { ...profile, runnerLabel: "constructor" },
        image,
      ),
    );
  }
});
