import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected =
  process.env.CHECKTRAIL_IMPORT_CONTEXT_IMAGE ??
  "checktrail-import-history:synthetic-v1";
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const args = [
  "run",
  "--rm",
  "--init",
  "--network",
  "none",
  "--read-only",
  "--cpus",
  "2",
  "--memory",
  "2g",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=256m",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--workdir",
  "/workspace",
  image,
];
const invoke = (command) =>
  execFileSync("docker", [...args, ...command], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
const started = performance.now();
const node = invoke(["node", "--version"]).trim(),
  git = invoke(["git", "--version"]).trim();
assert.equal(node, "v22.23.2");
assert.equal(git, "git version 2.47.3");
const preserved = JSON.parse(
  invoke([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "import-context",
  ]),
);
assert.equal(preserved.complete, true);
const native = JSON.parse(
  invoke([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "import-history",
  ]),
);
assert.equal(native.complete, true);
const guards = JSON.parse(
  invoke([
    "sh",
    "-c",
    `set -e
mkdir -p /tmp/checktrail-import-controls
cp -R /workspace/dist /workspace/scripts /tmp/checktrail-import-controls/
cp /workspace/package.json /tmp/checktrail-import-controls/
ln -s /workspace/node_modules /tmp/checktrail-import-controls/node_modules
cd /tmp/checktrail-import-controls
node scripts/verify-import-history-guards.mjs`,
  ]),
);
assert.equal(guards.sourceRestored, true);
assert.equal(guards.callbacksUnchanged, true);
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "import-history",
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  ),
);
const preservedInstalled = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "import-context",
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  ),
);
process.stdout.write(
  JSON.stringify({
    profile: "historical-imports-native-installed-v1",
    image,
    versions: { node, git },
    network: "none",
    init: true,
    cpus: 2,
    memory: "2g",
    repositoryMount: "readonly",
    rootFilesystemReadonly: true,
    temporaryFilesystemMiB: 256,
    preserved,
    native,
    guards,
    installed,
    preservedInstalled,
    durationMs: Math.round(performance.now() - started),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
