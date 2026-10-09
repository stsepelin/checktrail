import assert from "node:assert/strict";
import { pythonExtensionPins } from "../dist/src/python-extension-pins.js";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selectedImage = process.env.CHECKTRAIL_PYTHON_EXTENSIONS_IMAGE;
assert.ok(
  selectedImage,
  "Pass the operator-prepared frozen Python extension image",
);
const image = execFileSync(
  "docker",
  ["image", "inspect", selectedImage, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const task =
  process.env.CHECKTRAIL_TEST_TASK ?? `python-extensions-${process.pid}`;
assert.match(task, /^[a-z][a-z0-9-]{0,80}$/);
const cache = execFileSync("npm", ["config", "get", "cache"], {
  encoding: "utf8",
}).trim();
assert.ok(path.isAbsolute(cache));
const base = [
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
  "--pids-limit",
  "256",
  "--tmpfs",
  "/tmp:rw,exec,nosuid,nodev,size=1024m",
  "--label",
  "checktrail.task=" + task,
  "--mount",
  `type=bind,src=${repository},target=/workspace,readonly`,
  "--mount",
  `type=bind,src=${cache},target=/prepared-cache,readonly`,
  "--workdir",
  "/workspace",
  "--env",
  "npm_config_cache=/tmp/npm-cache",
  image,
];
const run = (args) =>
  execFileSync("docker", [...base, ...args], {
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 4 * 1048576,
  });
const runtime = JSON.parse(
  run([
    "python3",
    "-I",
    "-B",
    "-c",
    `import json,sys,pathlib,hashlib,platform;from importlib.metadata import distribution,version;node=pathlib.Path('/usr/local/bin/node').read_bytes();python=pathlib.Path(sys.executable).read_bytes();pins=json.loads(${JSON.stringify(JSON.stringify(pythonExtensionPins))});observed=[]
for pin in pins:
 data=pathlib.Path(distribution(pin['distribution']).locate_file(pin['file'])).read_bytes();actual={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()};observed.append({**pin,'observed':actual,'matches':actual['bytes']==pin['bytes'] and actual['sha256']==pin['sha256']})
print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'architecture':platform.machine(),'platform':sys.platform,'packages':{name:version(name) for name in ['pytest','mypy','ruff','pluggy']},'pythonBinary':{'bytes':len(python),'sha256':hashlib.sha256(python).hexdigest()},'nodeBinary':{'bytes':len(node),'sha256':hashlib.sha256(node).hexdigest()},'os':pathlib.Path('/etc/os-release').read_text(),'selectedNativeApis':observed}))`,
  ]),
);
assert.equal(runtime.python, "3.12.13");
assert.equal(runtime.architecture, "aarch64");
assert.equal(runtime.platform, "linux");
assert.deepEqual(runtime.packages, {
  pytest: "9.1.1",
  mypy: "2.3.1",
  ruff: "0.16.8",
  pluggy: "1.6.0",
});
assert.ok(
  runtime.selectedNativeApis.length > 0 &&
    runtime.selectedNativeApis.every((p) => p.matches),
);
const node = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    "console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))",
  ]),
);
assert.deepEqual(node, {
  version: "v22.23.2",
  platform: "linux",
  arch: "arm64",
});
const stage = (name) =>
  process.stderr.write(JSON.stringify({ stage: name }) + "\n");
stage("baseline");
const baseline = JSON.parse(
  run(["node", "scripts/verify-required-native-tests.mjs", "python"]),
);
assert.equal(baseline.required, 5);
assert.equal(baseline.passed, 5);
assert.equal(baseline.complete, true);
stage("source");
const lines = run([
  "/bin/sh",
  "-c",
  "node scripts/prepare-acceptance-cache-subset.mjs /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs python-extensions",
])
  .trim()
  .split("\n");
assert.equal(lines.length, 2);
const preparedCache = JSON.parse(lines[0]),
  source = JSON.parse(lines[1]);
assert.equal(source.required, 9);
assert.equal(source.passed, 9);
assert.equal(source.complete, true);
stage("guards");
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-python-extensions-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-python-extensions-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 15);
assert.ok(
  guards.controls.every(
    (c) =>
      c.originalPassed &&
      c.mutantCompiled &&
      c.mutantFailedAssertion &&
      c.restoredPassed,
  ),
);
stage("regressions");
const regressions = run([
  "node",
  "--test",
  "--test-reporter=tap",
  "dist/test/python-extensions.test.js",
  "dist/test/python-extension-planning.test.js",
  "dist/test/pytest-evidence.test.js",
  "dist/test/mypy-evidence.test.js",
  "dist/test/ruff-evidence.test.js",
]);
assert.match(regressions, /# fail 0\n/);
assert.match(regressions, /# skipped 0\n/);
const count = regressions.match(/# pass (\d+)\n/);
assert.ok(count && Number(count[1]) > 0);
stage("installed");
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "python-extensions",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 4 * 1048576,
    },
  ),
);
assert.equal(installed.profile.required, 9);
assert.equal(installed.profile.passed, 9);
assert.equal(installed.profile.complete, true);
const callbacks = JSON.parse(
  await readFile(
    path.join(repository, "scripts/required-native-tests.json"),
    "utf8",
  ),
)["python-extensions"];
const wheelPins = JSON.parse(
  await readFile(
    path.join(repository, "scripts/python-extensions-wheels.json"),
    "utf8",
  ),
);
process.stdout.write(
  JSON.stringify({
    runtime,
    node,
    image,
    baseline,
    source,
    guards,
    regressions: { passed: Number(count[1]), failed: 0, skipped: 0 },
    installed,
    preparedCache,
    callbacks,
    wheelPins,
    environment: {
      network: "none",
      sourceMount: "readonly",
      rootFilesystemReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 1024,
      temporaryFilesystemExecutable: true,
    },
    wholeDependencyClosureVerified: false,
    publisherLicenseClosureVerified: false,
    finalMatrixAccepted: false,
    gateAComplete: false,
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
