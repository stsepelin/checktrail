import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  realpath,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { pullPinnedImage } from "./pull-pinned-image.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(["linux", "darwin"].includes(process.platform));
assert.equal(process.arch, "arm64");
const reference =
  "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const name = "checktrail-tasks-runtime-" + process.pid,
  task = process.env.CHECKTRAIL_TEST_TASK ?? "tasks-runtime-native-arm64";
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const cache = await realpath(
  runAcceptanceNpm(["config", "get", "cache"], { encoding: "utf8" }).trim(),
);
assert.equal((await lstat(cache)).isDirectory(), true);
const run = (args, timeout = 1200000) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1048576,
  });
await pullPinnedImage(reference);
const [image] = JSON.parse(run(["image", "inspect", reference]));
assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), "checktrail-tasks-public-cache-")),
);
const preparedCache = path.join(temporary, "cache");
try {
  const prepared = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/prepare-acceptance-cache-subset.mjs", cache, preparedCache],
      { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 1048576 },
    ),
  );
  // Only the verified locked public tarballs are mounted. Make this owned tree
  // readable to the unprivileged container without exposing the host npm cache.
  async function publicPermissions(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await publicPermissions(file);
      else {
        assert.equal(entry.isFile(), true);
        await chmod(file, 0o444);
      }
    }
    await chmod(directory, 0o755);
  }
  await publicPermissions(temporary);
  const output = run([
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "checktrail.task=" + task,
    "--network",
    "none",
    "--read-only",
    "--user",
    "65532:65532",
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=2048m,mode=1777",
    "--mount",
    "type=bind,src=" + root + ",target=/workspace,readonly",
    "--mount",
    "type=bind,src=" + preparedCache + ",target=/prepared-cache,readonly",
    "--workdir",
    "/workspace",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID=" + image.Id,
    image.Id,
    "sh",
    "-c",
    "set -eu\nnode scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache\nnode scripts/verify-tasks-runtime.mjs native-linux-arm64-node22\nnode scripts/verify-tasks-runtime-package.mjs native-linux-arm64-node22\nnode scripts/verify-review-runtime.mjs native-linux-arm64-node22\nnode scripts/verify-required-native-tests.mjs lifecycle-runtime-bindings\nnode scripts/verify-lifecycle-platforms.mjs native-linux-arm64-node22\nnode scripts/verify-lifecycle-platforms-package.mjs native-linux-arm64-node22",
  ]);
  const packets = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(packets.length, 7);
  const [
    ,
    source,
    installed,
    reviewWorkflow,
    lifecycleAdmission,
    lifecycleSource,
    lifecycleInstalled,
  ] = packets;
  assert.equal(source.profileEvidence.complete, true);
  assert.equal(installed.evidence.profileEvidence.complete, true);
  assert.equal(source.harnessSha256, installed.evidence.harnessSha256);
  assert.equal(
    source.runtimeArtifactsSha256,
    installed.evidence.runtimeArtifactsSha256,
  );
  assert.equal(reviewWorkflow.complete, true);
  assert.equal(reviewWorkflow.runtime.containerImageId, image.Id);
  assert.equal(
    reviewWorkflow.installedEvidence.profile.runtime.containerImageId,
    image.Id,
  );
  assert.equal(lifecycleAdmission.complete, true);
  const nativeDefinitions = JSON.parse(
    await readFile(
      new URL("./required-native-tests.json", import.meta.url),
      "utf8",
    ),
  );
  const foundationProfiles = ["posix-cleanup", "posix-owner"];
  const foundationRequired = foundationProfiles.reduce(
    (total, profile) => total + nativeDefinitions[profile].length,
    0,
  );
  for (const evidence of [lifecycleSource, lifecycleInstalled.evidence]) {
    assert.equal(evidence.complete, true);
    assert.equal(evidence.required, 9);
    assert.equal(evidence.passed, 9);
    assert.equal(
      evidence.completionScope,
      "whole-profile-and-selected-platform-foundation",
    );
    assert.equal(evidence.foundation.complete, true);
    assert.deepEqual(
      evidence.foundation.profiles,
      foundationProfiles.map((profile) => ({
        profile,
        required: nativeDefinitions[profile].length,
      })),
    );
    assert.equal(evidence.foundation.required, foundationRequired);
    assert.equal(evidence.foundation.passed, foundationRequired);
    assert.equal(evidence.foundation.ledger.truncated, false);
    assert.equal(evidence.foundation.ledger.cases.length, foundationRequired);
    assert.ok(
      evidence.foundation.ledger.cases.every((row) => row.outcome === "passed"),
    );
    assert.equal(evidence.runtime.slot, "native-linux-arm64-node22");
    assert.equal(evidence.selectedRuntime.id, "native-linux-arm64-node22");
    assert.equal(evidence.runtime.containerImageId, image.Id);
    assert.equal(evidence.compiledEngine.beforeAfterByteIdentitiesMatch, true);
  }
  assert.equal(lifecycleSource.harnessSha256, lifecycleInstalled.harnessSha256);
  assert.equal(
    lifecycleSource.compiledEngine.treeSha256,
    lifecycleInstalled.compiledEngine.treeSha256,
  );
  assert.equal(
    lifecycleSource.compiledEngine.treeSha256,
    lifecycleInstalled.evidence.compiledEngine.treeSha256,
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      preparedPublicCache: prepared,
      profile: "tasks-runtime-arm64-foundation-v1",
      reference,
      imageId: image.Id,
      network: "none",
      sourceReadOnly: true,
      source,
      installed,
      reviewWorkflow,
      lifecycleAdmission,
      lifecycleSource,
      lifecycleInstalled,
      gateATasksMatrixComplete: false,
      gateALifecycleComplete: false,
    }) + "\n",
  );
} finally {
  let owned;
  try {
    owned = run(
      [
        "container",
        "inspect",
        name,
        "--format",
        '{{index .Config.Labels "checktrail.task"}}',
      ],
      10000,
    ).trim();
  } catch (error) {
    assert.match(
      error.stderr?.toString() ?? "",
      /No such (?:container|object)/,
    );
  }
  if (owned !== undefined) {
    assert.equal(owned, task);
    run(["rm", "-f", name], 10000);
  }
  assert.equal(
    run(["ps", "-aq", "--filter", "name=^/" + name + "$"], 10000).trim(),
    "",
  );
  await rm(temporary, { recursive: true, force: true });
}
