import { scalaArtifacts } from "../dist/src/scala-artifacts.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const selected =
  process.env.CHECKTRAIL_SCALA_CONTEXT_IMAGE ??
  "checktrail-scala-context:synthetic-v1";
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
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
  "/tmp:rw,nosuid,nodev,noexec,size=512m",
  ...(process.env.CHECKTRAIL_TEST_TASK
    ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
    : []),
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
    maxBuffer: 4 * 1048576,
    timeout: 360000,
  });
const runtime = JSON.parse(
  run([
    "node",
    "--input-type=module",
    "-e",
    'import {execFileSync} from "node:child_process"; import {readFileSync,readdirSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,scalaArchiveBytes:readFileSync("/opt/checktrail/scala3-3.9.0.zip").length,scalaArchiveSha256:createHash("sha256").update(readFileSync("/opt/checktrail/scala3-3.9.0.zip")).digest("hex"),scalaLibraries:readdirSync("/opt/checktrail/scala/lib").sort().map(name=>({name,bytes:readFileSync("/opt/checktrail/scala/lib/"+name).length,sha256:createHash("sha256").update(readFileSync("/opt/checktrail/scala/lib/"+name)).digest("hex")})),scalaVersion:execFileSync("java",["-Xmx256m","-cp","/opt/checktrail/scala/lib/*","dotty.tools.dotc.Main","-version"],{encoding:"utf8"}).trim(),java:execFileSync("java",["--version"],{encoding:"utf8"}).trim(),javac:execFileSync("javac",["--version"],{encoding:"utf8"}).trim(),git:execFileSync("git",["--version"],{encoding:"utf8"}).trim(),npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),os:readFileSync("/etc/os-release","utf8")}));',
  ]),
);
assert.equal(runtime.node, "v22.23.2");
assert.equal(runtime.platform, "linux");
assert.equal(runtime.arch, "arm64");
assert.equal(runtime.javac, "javac 25.0.4");
assert.equal(runtime.scalaArchiveBytes, 177629395);
assert.equal(
  runtime.scalaArchiveSha256,
  "2ec08ce51e400090058ad075fff0be764c7e16fb827d299c1be0d053d425770c",
);
assert.match(runtime.scalaVersion, /Scala compiler version 3\.9\.0/);
assert.match(runtime.java, /^openjdk 25\.0\.4 /);
assert.deepEqual(
  runtime.scalaLibraries,
  scalaArtifacts.runtimeLibraries
    .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name, "en")),
);
const source = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "cp -a /prepared-cache /tmp/npm-cache && node scripts/verify-required-native-tests.mjs context-scala",
  ]),
);
assert.equal(source.complete, true);
assert.equal(source.passed, 9);
// Guard mutations operate only on an owned compiled copy; the source mount stays read-only.
const guards = JSON.parse(
  run([
    "/bin/sh",
    "-c",
    "mkdir /tmp/guards && cp -a dist /tmp/guards/dist && mkdir /tmp/guards/scripts && cp scripts/verify-scala-context-guards.mjs /tmp/guards/scripts/ && cp package.json /tmp/guards/ && ln -s /workspace/node_modules /tmp/guards/node_modules && ln -s /workspace/assets /tmp/guards/assets && cd /tmp/guards && node scripts/verify-scala-context-guards.mjs",
  ]),
);
assert.equal(guards.controls.length, 23);
assert.ok(
  guards.controls.every(
    (control) =>
      control.originalPassed &&
      control.mutantCompiled &&
      control.mutantFailedAssertion &&
      control.restoredPassed,
  ),
);
const installed = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/verify-import-context-package.mjs"],
    {
      cwd: repository,
      env: {
        ...process.env,
        CHECKTRAIL_IMPORT_CONTEXT_PROFILE: "context-scala",
        CHECKTRAIL_IMPORT_CONTEXT_IMAGE: image,
      },
      encoding: "utf8",
      maxBuffer: 4 * 1048576,
      timeout: 120000,
    },
  ),
);
assert.equal(installed.profile.complete, true);
assert.equal(installed.profile.passed, 9);
process.stdout.write(
  JSON.stringify({
    scope:
      "Original synthetic Scala selected-binding controls; no AI inference or field evaluation",
    runtime,
    image,
    source,
    guards,
    installed,
    environment: {
      network: "none",
      sourceMount: "readonly",
      rootFilesystemReadonly: true,
      cpus: 2,
      memoryMiB: 2048,
      pids: 256,
      temporaryFilesystemMiB: 512,
      temporaryFilesystemExecutable: false,
    },
    inferenceInvoked: false,
    fieldEvaluationExecuted: false,
  }) + "\n",
);
