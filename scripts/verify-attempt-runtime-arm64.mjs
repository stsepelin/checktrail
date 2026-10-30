import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFile,
  realpath,
  mkdtemp,
  mkdir,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { pullPinnedImage } from "./pull-pinned-image.mjs";
import { runAcceptanceNpm } from "./install-acceptance-package.mjs";
import { attemptRuntimeBaseImages } from "./attempt-runtime-evidence.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(
  process.platform,
  "linux",
  "The selected Go tree must be native Linux",
);
assert.equal(process.arch, "arm64");
const goRoot = await realpath(
  execFileSync("go", ["env", "GOROOT"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  }).trim(),
);
assert.equal(
  execFileSync(path.join(goRoot, "bin/go"), ["version"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  }).trim(),
  "go version go1.27.1 linux/arm64",
);
const run = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 1200000,
    maxBuffer: 8 * 1048576,
  });
const created = await mkdtemp(path.join(tmpdir(), "checktrail-attempt-arm64-")),
  tag =
    "checktrail-attempt-runtime-" +
    process.pid +
    "-" +
    randomBytes(6).toString("hex"),
  name = tag + "-native",
  definition = path.join(root, "scripts/attempt-runtime-tools.Dockerfile");
let failure, result;
const cleanupErrors = [];
try {
  const temporary = await realpath(created),
    cache = path.join(temporary, "public-cache"),
    bytes = await readFile(definition),
    text = bytes.toString("utf8");
  assert.ok(
    text.startsWith(
      "FROM " +
        attemptRuntimeBaseImages.node +
        " AS node\nFROM " +
        attemptRuntimeBaseImages.system +
        "\n",
    ),
  );
  assert.equal(text.split("\n").filter((x) => x.startsWith("FROM ")).length, 2);
  for (const ref of Object.values(attemptRuntimeBaseImages))
    await pullPinnedImage(ref);
  const context = path.join(temporary, "empty-context");
  await mkdir(context);
  run([
    "build",
    "--network=none",
    "--label",
    "checktrail.task=attempt-runtime-native-arm64",
    "--file",
    definition,
    "--tag",
    tag,
    context,
  ]);
  const [image] = JSON.parse(run(["image", "inspect", tag]));
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Architecture, "arm64");
  assert.equal(image.Os, "linux");
  const hostCache = runAcceptanceNpm(["config", "get", "cache"], {
    encoding: "utf8",
  }).trim();
  execFileSync(
    process.execPath,
    ["scripts/prepare-acceptance-cache-subset.mjs", hostCache, cache],
    { cwd: root, encoding: "utf8", timeout: 120000 },
  );
  async function readable(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await readable(file);
      else {
        assert.ok(entry.isFile());
        await chmod(file, 0o444);
      }
    }
    await chmod(directory, 0o755);
  }
  await readable(cache);
  await chmod(temporary, 0o755);
  const output = run([
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "checktrail.task=attempt-runtime-native-arm64",
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
    "type=bind,src=" + cache + ",target=/prepared-cache,readonly",
    "--mount",
    "type=bind,src=" + goRoot + ",target=/selected-go,readonly",
    "--env",
    "GOROOT=/selected-go",
    "--env",
    "GOTOOLCHAIN=local",
    "--env",
    "PATH=/usr/local/bin:/selected-go/bin:/usr/bin:/bin",
    "--env",
    "HOME=/tmp",
    "--workdir",
    "/workspace",
    "--env",
    "npm_config_cache=/tmp/npm-cache",
    "--env",
    "CHECKTRAIL_ATTEMPT_RUNTIME_IMAGE_REFERENCE=" + image.Id,
    "--env",
    "CHECKTRAIL_ATTEMPT_RUNTIME_IMAGE_ID=" + image.Id,
    "--env",
    "CHECKTRAIL_ATTEMPT_BASE_NODE_REFERENCE=" + attemptRuntimeBaseImages.node,
    "--env",
    "CHECKTRAIL_ATTEMPT_BASE_SYSTEM_REFERENCE=" +
      attemptRuntimeBaseImages.system,
    image.Id,
    "sh",
    "-c",
    "set -eu\nnode scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache >/dev/null\nnode scripts/verify-attempt-runtime.mjs native-linux-arm64-node22",
  ]);
  const attemptRuntime = JSON.parse(output);
  assert.equal(attemptRuntime.profileEvidence.passed, 9);
  assert.equal(attemptRuntime.installedEvidence.profileEvidence.passed, 9);
  assert.equal(attemptRuntime.runtime.containerImageId, image.Id);
  assert.equal(attemptRuntime.runtime.containerReference, image.Id);
  assert.equal(
    attemptRuntime.runtime.containerDefinitionSha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(definition), bytes);
  result = {
    schemaVersion: 1,
    scope:
      "Original synthetic archive controls with pinned Node and observed native Git prerequisites",
    baseImages: attemptRuntimeBaseImages,
    imageId: image.Id,
    definitionSha256: createHash("sha256").update(bytes).digest("hex"),
    network: "none",
    sourceReadOnly: true,
    attemptRuntime,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  };
} catch (error) {
  failure = error;
} finally {
  for (const cleanup of [
    () => {
      if (
        run([
          "ps",
          "--all",
          "--filter",
          "name=^/" + name + "$",
          "--format",
          "{{.ID}}",
        ]).trim()
      )
        run(["rm", "--force", name]);
    },
    () => {
      if (
        run([
          "image",
          "ls",
          "--filter",
          "reference=" + tag,
          "--format",
          "{{.ID}}",
        ]).trim()
      )
        run(["image", "rm", tag]);
    },
    () => rm(created, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}
if (cleanupErrors.length)
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    "Native attempt runtime cleanup failed",
    { cause: failure ?? cleanupErrors[0] },
  );
if (failure) throw failure;
process.stdout.write(JSON.stringify(result) + "\n");
