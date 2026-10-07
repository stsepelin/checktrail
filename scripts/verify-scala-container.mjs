import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected =
  process.env.CHECKTRAIL_SCALA_IMAGE ?? "checktrail-scala-test:3.9.0";
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const arguments_ = [
  "run",
  "--rm",
  "--init",
  "--network",
  "none",
  "--cpus",
  "2",
  "--memory",
  "2g",
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--workdir",
  "/workspace",
  image,
];
const invoke = (args) =>
  execFileSync("docker", [...arguments_, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
const started = performance.now();
const node = invoke(["node", "--version"]).trim();
const java = invoke(["java", "--version"]).trim();
assert.equal(node, "v22.23.2");
assert.match(
  java,
  /^openjdk 25\.0\.4 2026-07-21 LTS\nOpenJDK Runtime Environment Temurin-25\.0\.4\+7 /,
);
const native = JSON.parse(
  invoke(["node", "scripts/verify-required-native-tests.mjs", "scala"]),
);
assert.equal(native.complete, true);
const guards = JSON.parse(
  invoke([
    "sh",
    "-c",
    `set -e
mkdir -p /tmp/checktrail-scala-controls
cp -R /workspace/dist /workspace/scripts /tmp/checktrail-scala-controls/
cp /workspace/package.json /tmp/checktrail-scala-controls/
ln -s /workspace/node_modules /tmp/checktrail-scala-controls/node_modules
cd /tmp/checktrail-scala-controls
node scripts/verify-scala-guards.mjs`,
  ]),
);
assert.equal(guards.sourceRestored, true);
assert.equal(guards.callbacksUnchanged, true);

const installed = JSON.parse(
  execFileSync(process.execPath, ["scripts/verify-scala-package.mjs"], {
    cwd: repository,
    env: { ...process.env, CHECKTRAIL_SCALA_IMAGE: image },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }),
);
process.stdout.write(
  JSON.stringify({
    image,
    versions: { node, java },
    network: "none",
    init: true,
    cpus: 2,
    memory: "2g",
    repositoryMount: "readonly",
    rootFilesystemReadonly: false,
    native,
    guards,
    installed,
    durationMs: Math.round(performance.now() - started),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
