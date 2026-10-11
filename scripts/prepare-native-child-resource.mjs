import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
assert.ok(
  ["linux", "darwin"].includes(process.platform),
  "Native child resource platform unavailable",
);
assert.equal(
  process.argv.length,
  4,
  "Expected private empty output and explicit Node header directories",
);
assert.ok(
  Number(process.versions.napi) >= 8,
  "Native child resource requires Node-API 8",
);
const output = path.resolve(process.argv[2]),
  headers = path.resolve(process.argv[3]);
assert.equal(
  await realpath(output),
  output,
  "Output directory must not follow symlinks",
);
assert.equal(
  await realpath(headers),
  headers,
  "Node header directory must not follow symlinks",
);
const stat = await lstat(output);
assert.ok(
  stat.isDirectory() &&
    stat.uid === process.getuid() &&
    (stat.mode & 0o077) === 0,
  "Output directory must be private and caller owned",
);
assert.deepEqual(
  await readdir(output),
  [],
  "Output directory must be empty before preparation",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = fileURLToPath(
    new URL("./native-child-resource.c", import.meta.url),
  ),
  compiler = await realpath("/usr/bin/cc");
const headerFiles = [
  "js_native_api.h",
  "js_native_api_types.h",
  "node_api.h",
  "node_api_types.h",
  "node_version.h",
];
async function inputs() {
  const selected = [];
  for (const file of headerFiles) {
    const target = path.join(headers, file),
      before = await lstat(target);
    assert.equal(
      await realpath(target),
      target,
      "Selected Node header must not follow symlinks",
    );
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.size > 0 &&
        before.size <= 2 * 1024 * 1024,
      "Selected Node header must be bounded and regular",
    );
    const bytes = await readFile(target),
      after = await lstat(target);
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        bytes.length === before.size,
      "Selected Node header changed during capture",
    );
    selected.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return {
    sourceSha256: hash(await readFile(source)),
    compilerSha256: hash(await readFile(compiler)),
    selectedNodeHeaders: selected,
  };
}
const before = await inputs();
const version = spawnSync(compiler, ["--version"], {
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 65536,
});
assert.equal(version.status, 0, "Native resource compiler unavailable");
assert.ok(!version.error && !version.signal && version.stdout.trim());
const staging = await mkdtemp(path.join(output, ".child-resource-staging-"));
try {
  const binary = path.join(staging, "binding.node");
  const compileArguments = [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=checktrail_native_child_resource",
    "-I",
    headers,
    ...(process.platform === "darwin"
      ? ["-bundle", "-undefined", "dynamic_lookup"]
      : ["-fPIC", "-shared"]),
    source,
    "-o",
    binary,
  ];
  const built = spawnSync(compiler, compileArguments, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
  });
  assert.equal(built.status, 0, built.stderr);
  assert.ok(
    !built.error && !built.signal,
    "Native child resource compilation did not complete",
  );
  const binaryStat = await lstat(binary);
  assert.ok(
    binaryStat.isFile() &&
      !binaryStat.isSymbolicLink() &&
      binaryStat.uid === process.getuid() &&
      binaryStat.nlink === 1 &&
      binaryStat.size > 0 &&
      binaryStat.size <= 16 * 1024 * 1024,
  );
  assert.deepEqual(
    await inputs(),
    before,
    "Native resource source compiler or selected Node headers changed during compilation",
  );
  const receipt = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    napiVersion: 8,
    preparedByNode: process.versions.node,
    preparedByNodeExecutableSha256: hash(
      await readFile(await realpath(process.execPath)),
    ),
    ...before,
    compilerVersion: version.stdout.split(/\r?\n/)[0],
    binarySha256: hash(await readFile(binary)),
    binaryPath: "native-child-resource/binding.node",
    selectedNodeHeaderClosureComplete: false,
    compilerSdkClosureVerified: false,
    completeNativeArtifactClosure: false,
  };
  await writeFile(
    path.join(staging, "build.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  assert.deepEqual(
    (await readdir(staging)).sort(),
    ["binding.node", "build.json"],
    "Native resource publication contains unexpected artifacts",
  );
  assert.deepEqual(
    await readdir(output),
    [path.basename(staging)],
    "Output directory changed before publication",
  );
  await rename(staging, path.join(output, "native-child-resource"));
  process.stdout.write(JSON.stringify(receipt) + "\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}
