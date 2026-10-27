import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, lstat, mkdtemp, readdir, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { pullPinnedImage } from "./pull-pinned-image.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(
  process.platform,
  "linux",
  "The resource container requires the selected native Linux Go tree",
);
assert.equal(process.arch, "arm64");
assert.ok(
  process.getuid() > 0,
  "Native resource workload must use an unprivileged caller",
);
const reference =
  "docker.io/library/node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const name = "checktrail-resource-runtime-" + process.pid,
  task = process.env.CHECKTRAIL_TEST_TASK ?? "resource-runtime-native-arm64";
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const cache = await realpath(
  runAcceptanceNpm(["config", "get", "cache"], { encoding: "utf8" }).trim(),
);
assert.equal((await lstat(cache)).isDirectory(), true);
const goRoot = await realpath(
  execFileSync("go", ["env", "GOROOT"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim(),
);
assert.equal(
  execFileSync(path.join(goRoot, "bin/go"), ["version"], {
    encoding: "utf8",
    timeout: 10000,
  }).trim(),
  "go version go1.27.1 linux/arm64",
);
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
  await mkdtemp(path.join(tmpdir(), "checktrail-resource-public-cache-")),
);
const preparedCache = path.join(temporary, "cache");
try {
  const prepared = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/prepare-resource-cache-subset.mjs", cache, preparedCache],
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
    String(process.getuid()) + ":" + String(process.getgid()),
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
    "--mount",
    "type=bind,src=" + goRoot + ",target=/selected-go,readonly",
    "--workdir",
    "/workspace",
    "--env",
    "GOROOT=/selected-go",
    "--env",
    "GOTOOLCHAIN=local",
    "--env",
    "HOME=/tmp",
    "--env",
    "PATH=/usr/local/bin:/selected-go/bin:/usr/bin:/bin",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "CHECKTRAIL_REVIEW_RUNTIME_IMAGE_ID=" + image.Id,
    image.Id,
    "sh",
    "-c",
    "set -eu\nnode scripts/prepare-resource-cache-subset.mjs /prepared-cache /tmp/npm-cache\nnode scripts/verify-resource-release-readiness.mjs native-linux-arm64-node22",
  ]);
  const packets = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(packets.length, 2);
  const [cacheReceipt, receipt] = packets;
  assert.equal(cacheReceipt.registryMetadataCopied, false);
  assert.equal(receipt.profile, "resource-release-readiness");
  assert.equal(receipt.runtime.containerImageId, image.Id);
  assert.equal(receipt.runtime.selectedRuntime.id, "native-linux-arm64-node22");
  for (const profile of [receipt.source, receipt.installed.profile]) {
    assert.equal(profile.complete, true);
    assert.equal(profile.required, 9);
    assert.equal(profile.passed, 9);
    assert.equal(profile.ledger.truncated, false);
    assert.equal(profile.ledger.cases.length, 9);
    assert.ok(profile.ledger.cases.every((row) => row.outcome === "passed"));
  }
  assert.equal(receipt.installed.offlineProductionInstall, true);
  assert.equal(receipt.installed.harnessOutsideInstalledPackage, true);
  assert.equal(
    receipt.compiledEngineSha256,
    receipt.installed.compiledEngineSha256,
  );
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      profile: "resource-release-native-arm64",
      reference,
      imageId: image.Id,
      preparedPublicCache: prepared,
      network: "none",
      sourceReadOnly: true,
      receipt,
      gateAComplete: false,
      inferenceInvoked: false,
      fieldEvaluationExecuted: false,
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
