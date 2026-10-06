import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { performance } from "node:perf_hooks";
import process from "node:process";
const repository = fileURLToPath(new URL("../", import.meta.url)),
  selected =
    process.env.CHECKTRAIL_DOTNET_BUILD_IMAGE ??
    "checktrail-dotnet-test:10.0.401";
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
  "--cpus",
  "2",
  "--memory",
  "2g",
  ...(process.env.CHECKTRAIL_TEST_TASK
    ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
    : []),
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--env",
  "CHECKTRAIL_DOTNET_BUILD_CACHE=/workspace/.checktrail/dotnet-build-dependencies",
  "--workdir",
  "/workspace",
  image,
];
const invoke = (arguments_) =>
  execFileSync("docker", [...args, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
const started = performance.now(),
  node = invoke(["node", "--version"]).trim(),
  sdk = invoke(["dotnet", "--list-sdks"]).trim(),
  compiler = invoke([
    "dotnet",
    "exec",
    "/usr/share/dotnet/sdk/10.0.401/Roslyn/bincore/csc.dll",
    "-version",
  ]).trim();
assert.equal(node, "v22.23.2");
assert.equal(sdk, "10.0.401 [/usr/share/dotnet/sdk]");
assert.equal(
  compiler,
  "5.9.0-1.26423.113 (e34a38d2ae1fc26406a317517196e55c68ff83ab)",
);
const native = JSON.parse(
  invoke([
    "node",
    "scripts/verify-required-native-tests.mjs",
    "dotnet-generated",
  ]),
);
assert.equal(native.complete, true);

const installed = JSON.parse(
  execFileSync(process.execPath, ["scripts/verify-dotnet-build-package.mjs"], {
    cwd: repository,
    env: {
      ...process.env,
      CHECKTRAIL_DOTNET_BUILD_IMAGE: image,
      CHECKTRAIL_DOTNET_PROFILE: "dotnet-generated",
    },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }),
);
process.stdout.write(
  JSON.stringify({
    image,
    versions: { node, sdk, compiler },
    network: "none",
    init: true,
    cpus: 2,
    memory: "2g",
    repositoryMount: "readonly",
    rootFilesystemReadonly: false,
    native,
    installed,
    durationMs: Math.round(performance.now() - started),
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
    windowsVerified: false,
  }) + "\n",
);
