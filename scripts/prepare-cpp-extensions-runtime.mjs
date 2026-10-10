import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { mavenHash } from "../dist/src/maven.js";
import {
  cppExtensionsToolNames,
  cppExtensionsSupportedVersion,
} from "../dist/src/cpp-extensions-native.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsSdkPath,
} from "../dist/src/cpp-extensions-contract.js";
const root = await realpath(fileURLToPath(new URL("../", import.meta.url))),
  destination = path.join(root, ".checktrail/cpp-extensions-runtime");
await mkdir(path.dirname(destination), { recursive: true });
assert.equal(
  await realpath(path.dirname(destination)),
  path.dirname(destination),
);
await assert.rejects(lstat(destination), { code: "ENOENT" });
const baseIdentity = path.join(
  root,
  ".checktrail/cpp-tools-runtime/identity.json",
);
let newlyPrepared = false;
try {
  await lstat(baseIdentity);
  assert.equal(
    process.env.CHECKTRAIL_CPP_EXTENSIONS_REUSE_RUNTIME,
    "1",
    "Explicit operator reuse is required for an existing prepared image",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  execFileSync(process.execPath, ["scripts/prepare-cpp-tools-runtime.mjs"], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  newlyPrepared = true;
}
const temporary = await mkdtemp(
  path.join(path.dirname(destination), "cpp-extensions-preparation-"),
);
let completed = false;
try {
  const prepared = JSON.parse(await readFile(baseIdentity, "utf8"));
  assert.match(prepared.task, /^[a-z][a-z0-9-]{0,80}$/);
  assert.match(prepared.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(prepared.tag, `checktrail-${prepared.task}:public`);
  const docker = (args) =>
    execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1048576,
    });
  const [image] = JSON.parse(docker(["image", "inspect", prepared.image]));
  assert.equal(image.Config.Labels["checktrail.task"], prepared.task);
  assert.equal(image.Architecture, "arm64");
  const archives = JSON.parse(
    await readFile(path.join(root, "scripts/cpp-tools-archives.json"), "utf8"),
  ).archives;
  assert.deepEqual(
    prepared.archives.map(({ path, bytes, sha256 }) => ({
      path,
      bytes,
      sha256,
    })),
    archives.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  );
  const base = [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--pids-limit",
    "256",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,exec,size=256m",
    "--label",
    "checktrail.task=" + prepared.task,
    "--mount",
    `type=bind,src=${root},target=/workspace,readonly`,
    "--workdir",
    "/workspace",
    prepared.image,
  ];
  const sdk = JSON.parse(
    docker([...base, "node", "scripts/collect-cpp-extensions-sdk.mjs"]),
  );
  assert.equal(sdk.schemaVersion, 1);
  assert.equal(sdk.wholeRuntimeClosureVerified, false);
  assert.equal(sdk.pinsSha256, mavenHash(JSON.stringify(sdk.pins)));
  const pins = cppExtensionsConfigSchema.shape.sdk.parse(sdk.pins);
  assert.equal(new Set(pins.map((p) => p.path)).size, pins.length);
  assert.ok(
    pins.every(
      (p) =>
        cppExtensionsSdkPath(p.path) &&
        cppExtensionsSdkPath(p.resolved) &&
        pins.some(
          (q) =>
            q.path === p.resolved &&
            q.resolved === p.resolved &&
            q.bytes === p.bytes &&
            q.sha256 === p.sha256,
        ),
    ),
  );
  assert.equal(
    pins.reduce((n, p) => n + p.bytes, 0),
    sdk.bytes,
  );
  assert.ok(sdk.bytes <= 512 * 1048576);
  const versions = JSON.parse(
    docker([
      ...base,
      "node",
      "--input-type=module",
      "-e",
      `import {spawnSync} from 'node:child_process';const names=${JSON.stringify(cppExtensionsToolNames)};const rows=names.map(name=>{const executable=name==='as'||name==='ld'?'/usr/bin/'+name:name;const args=name==='clang'||name==='clang++'?['--no-default-config','--version']:['--version'];const r=spawnSync(executable,args,{encoding:'utf8',env:{...process.env,CCC_OVERRIDE_OPTIONS:'#'}});if(r.error||r.status!==0||r.stderr)throw Error('Native version collection incomplete');return {name,output:r.stdout};});console.log(JSON.stringify(rows));`,
    ]),
  );
  assert.deepEqual(
    versions.map((v) => v.name),
    [...cppExtensionsToolNames],
  );
  for (const v of versions)
    assert.ok(cppExtensionsSupportedVersion(v.name, v.output));
  const identity = {
    ...prepared,
    profile: "declared-local-cmake-transitive-sdk-v1",
    nativeVersions: versions,
    sdkPins: sdk.pins.length,
    sdkBytes: sdk.bytes,
    sdkPinsSha256: sdk.pinsSha256,
    wholeRuntimeClosureVerified: false,
  };
  await writeFile(
    path.join(temporary, "sdk.json"),
    JSON.stringify(sdk) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(temporary, "identity.json"),
    JSON.stringify(identity, null, 2) + "\n",
    { flag: "wx" },
  );
  await chmod(path.join(temporary, "sdk.json"), 0o644);
  await chmod(path.join(temporary, "identity.json"), 0o644);
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  completed = true;
  process.stdout.write(
    JSON.stringify({
      profile: identity.profile,
      image: identity.image,
      sdkPins: identity.sdkPins,
      sdkBytes: identity.sdkBytes,
      sdkPinsSha256: identity.sdkPinsSha256,
      publicSdkReadableByNativeUser: true,
      packageSignaturesDisabled: false,
      wholeRuntimeClosureVerified: false,
    }) + "\n",
  );
} finally {
  if (!completed) {
    await rm(temporary, { recursive: true, force: true });
    if (newlyPrepared)
      execFileSync(
        process.execPath,
        ["scripts/cleanup-cpp-tools-runtime.mjs"],
        { cwd: root, stdio: "pipe" },
      );
  }
}
