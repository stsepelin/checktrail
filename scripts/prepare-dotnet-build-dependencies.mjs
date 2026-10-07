import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  open,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { TextDecoder } from "node:util";
import { Buffer } from "node:buffer";

const root = fileURLToPath(new URL("../", import.meta.url));
const cacheRoot = path.join(root, ".checktrail");
const destination = path.join(cacheRoot, "dotnet-build-dependencies");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function absent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw Error(
    "Preserve the existing .NET dependency destination; prepare a new cache explicitly",
  );
}
await absent(destination);
await mkdir(cacheRoot, { recursive: true });
const cacheInfo = await lstat(cacheRoot);
assert.ok(
  cacheInfo.isDirectory() && !cacheInfo.isSymbolicLink(),
  "Cache root must be a regular directory",
);
const source = JSON.parse(
  await readFile(
    path.join(root, "scripts/dotnet-build-fixture-projects.json"),
    "utf8",
  ),
);
assert.equal(source.sdkVersion, "10.0.401");
assert.equal(source.runtimeVersion, "10.0.12");
const selected =
  process.env.CHECKTRAIL_DOTNET_BUILD_IMAGE ??
  "checktrail-dotnet-test:10.0.401";
const image = execFileSync(
  "docker",
  ["image", "inspect", selected, "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.ok(
  typeof process.getuid === "function" && typeof process.getgid === "function",
  "Dependency preparation requires a POSIX host user identity",
);
const containerUser = `${process.getuid()}:${process.getgid()}`;
const leaseFile = destination + ".preparing";
const lease = await open(leaseFile, "wx");
let temporary;
try {
  temporary = await mkdtemp(path.join(cacheRoot, "dotnet-build-prepare-"));
  const workspace = path.join(temporary, "workspace"),
    artifacts = path.join(temporary, "prepared/artifacts"),
    prepared = path.dirname(artifacts);
  await cp(path.join(root, "examples/dotnet-build"), workspace, {
    recursive: true,
    errorOnExist: true,
  });
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(workspace, "NuGet.Config"),
    '<configuration><packageSources><clear/><add key="public" value="https://api.nuget.org/v3/index.json"/></packageSources></configuration>\n',
  );
  const args = [
    "run",
    "--rm",
    "--init",
    "--user",
    containerUser,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--mount",
    `type=bind,src=${temporary},target=/preparation`,
    "--env",
    "DOTNET_CLI_TELEMETRY_OPTOUT=1",
    "--env",
    "DOTNET_NOLOGO=1",
    "--env",
    "DOTNET_CLI_USE_MSBUILD_SERVER=0",
    "--env",
    "MSBUILDDISABLENODEREUSE=1",
    "--env",
    "DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1",
    "--env",
    "NUGET_HTTP_CACHE_PATH=/preparation/http",
    "--env",
    "DOTNET_CLI_HOME=/preparation/home",
    "--env",
    "HOME=/preparation/home",
    "--workdir",
    "/preparation/workspace",
    ...(process.env.CHECKTRAIL_TEST_TASK
      ? ["--label", "checktrail.task=" + process.env.CHECKTRAIL_TEST_TASK]
      : []),
    image,
  ];
  assert.equal(
    execFileSync("docker", [...args, "dotnet", "--version"], {
      encoding: "utf8",
    }).trim(),
    "10.0.401",
  );
  const output = execFileSync(
    "docker",
    [
      ...args,
      "dotnet",
      "restore",
      "Original.slnx",
      "--configfile",
      "/preparation/workspace/NuGet.Config",
      "--packages",
      "/preparation/prepared/artifacts",
      "--disable-parallel",
      "-p:NuGetAudit=false",
      "-m:1",
      "-nr:false",
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  await writeFile(path.join(temporary, "restore.log"), output);
  const locks = [];
  for (const project of source.projects) {
    const file = path.posix.join(
      path.posix.dirname(project.file),
      "packages.lock.json",
    );
    const bytes = await readFile(path.join(workspace, file));
    const lock = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    assert.equal(lock.version, 1);
    assert.ok(
      Object.hasOwn(lock.dependencies, "net10.0"),
      "Every project must have a target-bound package lock",
    );
    await mkdir(path.join(prepared, "fixture-locks", path.dirname(file)), {
      recursive: true,
    });
    await writeFile(path.join(prepared, "fixture-locks", file), bytes, {
      flag: "wx",
    });
    locks.push({ file, sha256: hash(bytes) });
  }
  const files = [];
  let entries = 0,
    total = 0;
  async function walk(prefix = "") {
    for (const item of await readdir(path.join(artifacts, prefix), {
      withFileTypes: true,
    })) {
      assert.ok(++entries <= 20000, "Dependency inventory bound");
      const relative = path.posix.join(prefix, item.name),
        file = path.join(artifacts, relative),
        info = await lstat(file);
      assert.ok(!info.isSymbolicLink(), "Dependency links are not admitted");
      if (info.isDirectory()) {
        await walk(relative);
        continue;
      }
      assert.ok(
        info.isFile() && info.size >= 0 && info.size <= 32 * 1024 * 1024,
        "Bounded regular artifact required",
      );
      total += info.size;
      assert.ok(total <= 256 * 1024 * 1024, "Dependency byte bound");
      const bytes = await readFile(file);
      assert.equal(bytes.length, info.size);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
      assert.ok(files.length <= 4096, "Dependency file bound");
    }
  }
  await walk();
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  for (const [name, version] of [
    ["microsoft.net.test.sdk", "18.10.1"],
    ["nunit", "4.6.1"],
    ["nunit3testadapter", "5.0.0"],
  ])
    assert.ok(
      files.some(
        (file) => file.path === `${name}/${version}/${name}.${version}.nupkg`,
      ),
      "Pinned package closure required",
    );
  const manifest = JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n";
  assert.ok(Buffer.byteLength(manifest) <= 1024 * 1024 && files.length > 0);
  await writeFile(path.join(prepared, "repository.json"), manifest, {
    flag: "wx",
  });
  await writeFile(
    path.join(prepared, "fixture-locks.json"),
    JSON.stringify({ schemaVersion: 1, locks }, null, 2) + "\n",
    { flag: "wx" },
  );
  await absent(destination);
  // One prepared directory publishes the artifacts, manifest and all fixture locks together.
  await rename(prepared, destination);
  process.stdout.write(
    JSON.stringify({
      image,
      sdkVersion: source.sdkVersion,
      runtimeVersion: source.runtimeVersion,
      files: files.length,
      bytes: total,
      repositorySha256: hash(manifest),
      fixtureLocks: locks.length,
      source: "Original public C#/F#/VB/NUnit fixture restore",
      networkUsedForExplicitPreparation: true,
      engineInstalledDependencies: false,
      publisherSignatureVerified: false,
    }) + "\n",
  );
} finally {
  try {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  } finally {
    await lease.close();
    await rm(leaseFile);
  }
}
