import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const keys = (value, names) =>
  assert.deepEqual(
    Object.keys(value).sort(),
    [...names].sort(),
    "Native resource fields differ",
  );
export function parseNativeChildResourceSnapshot(bytes, expected) {
  assert.ok(
    bytes instanceof Uint8Array &&
      bytes.byteLength > 0 &&
      bytes.byteLength <= 4096,
    "Native resource snapshot bytes exceed bounds",
  );
  const text = Buffer.from(bytes).toString("utf8");
  assert.ok(
    Buffer.from(text).equals(Buffer.from(bytes)),
    "Native resource snapshot UTF-8 differs",
  );
  const value = JSON.parse(text);
  assert.equal(
    JSON.stringify(value) + "\n",
    text,
    "Native resource snapshot encoding differs",
  );
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  keys(value, [
    "schemaVersion",
    "napiVersion",
    "pid",
    "selfScope",
    "childrenScope",
    "self",
    "children",
  ]);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.napiVersion, 8);
  assert.ok(integer(value.pid) && value.pid > 1);
  assert.equal(
    value.pid,
    expected.pid,
    "Native resource snapshot process differs",
  );
  assert.equal(value.selfScope, "RUSAGE_SELF");
  assert.equal(value.childrenScope, "RUSAGE_CHILDREN");
  assert.ok(
    ["linux", "darwin"].includes(expected.platform),
    "Native resource snapshot platform unavailable",
  );
  const unit = expected.platform === "darwin" ? "bytes" : "KiB";
  for (const scope of ["self", "children"]) {
    const usage = value[scope];
    assert.ok(usage && typeof usage === "object" && !Array.isArray(usage));
    keys(usage, [
      "userCpuMicroseconds",
      "systemCpuMicroseconds",
      "peakRssRaw",
      "peakRssKiB",
      "peakRssRawUnit",
    ]);
    assert.ok(
      [
        usage.userCpuMicroseconds,
        usage.systemCpuMicroseconds,
        usage.peakRssRaw,
        usage.peakRssKiB,
      ].every(integer),
      "Native resource snapshot counters invalid",
    );
    assert.equal(
      usage.peakRssRawUnit,
      unit,
      "Native resource snapshot RSS units differ",
    );
    assert.equal(
      usage.peakRssKiB,
      unit === "bytes" ? Math.ceil(usage.peakRssRaw / 1024) : usage.peakRssRaw,
      "Native resource snapshot RSS normalization differs",
    );
  }
  return {
    ...value,
    summedProcessTreeRss: false,
    unreapedDescendantCoverage: "unverified",
    counterScope: "kernel-self-and-reaped-children",
  };
}
export async function loadNativeChildResource(directory) {
  assert.ok(
    ["linux", "darwin"].includes(process.platform),
    "Native child resource platform unavailable",
  );
  const canonical = path.resolve(directory);
  assert.equal(
    await realpath(canonical),
    canonical,
    "Native resource bundle must not follow symlinks",
  );
  const dirStat = await lstat(canonical);
  assert.ok(
    dirStat.isDirectory() &&
      dirStat.uid === process.getuid() &&
      (dirStat.mode & 0o077) === 0,
    "Native resource bundle must be private and caller owned",
  );
  assert.deepEqual(
    (await readdir(canonical)).sort(),
    ["binding.node", "build.json"],
    "Native resource bundle artifacts differ",
  );
  async function capture(name, limit) {
    const file = path.join(canonical, name),
      before = await lstat(file);
    assert.equal(
      await realpath(file),
      file,
      "Native resource artifact must not follow symlinks",
    );
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.uid === process.getuid() &&
        before.nlink === 1 &&
        before.size > 0 &&
        before.size <= limit,
      "Native resource artifact must be bounded regular and caller owned",
    );
    const bytes = await readFile(file),
      after = await lstat(file);
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        bytes.length === before.size,
      "Native resource artifact changed during capture",
    );
    return { file, sha256: hash(bytes), bytes };
  }
  const metadata = await capture("build.json", 65536),
    binary = await capture("binding.node", 16 * 1024 * 1024),
    build = JSON.parse(metadata.bytes.toString("utf8"));
  keys(build, [
    "schemaVersion",
    "platform",
    "architecture",
    "napiVersion",
    "preparedByNode",
    "preparedByNodeExecutableSha256",
    "sourceSha256",
    "compilerSha256",
    "selectedNodeHeaders",
    "compilerVersion",
    "binarySha256",
    "binaryPath",
    "selectedNodeHeaderClosureComplete",
    "compilerSdkClosureVerified",
    "completeNativeArtifactClosure",
  ]);
  for (const name of [
    "preparedByNodeExecutableSha256",
    "sourceSha256",
    "compilerSha256",
    "binarySha256",
  ])
    assert.match(build[name], /^[a-f0-9]{64}$/);
  assert.match(build.preparedByNode, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.ok(
    typeof build.compilerVersion === "string" &&
      build.compilerVersion.length > 0 &&
      build.compilerVersion.length <= 1024,
  );
  assert.ok(
    Array.isArray(build.selectedNodeHeaders) &&
      build.selectedNodeHeaders.length === 5,
  );
  const expectedHeaders = [
    "js_native_api.h",
    "js_native_api_types.h",
    "node_api.h",
    "node_api_types.h",
    "node_version.h",
  ];
  assert.deepEqual(
    build.selectedNodeHeaders.map((header) => header.file),
    expectedHeaders,
    "Selected Node header identities differ",
  );
  for (const header of build.selectedNodeHeaders) {
    keys(header, ["file", "bytes", "sha256"]);
    assert.ok(
      integer(header.bytes) &&
        header.bytes > 0 &&
        header.bytes <= 2 * 1024 * 1024,
    );
    assert.match(header.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(
    build.sourceSha256,
    hash(await readFile(new URL("./native-child-resource.c", import.meta.url))),
    "Native resource binding source differs",
  );
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.platform, process.platform);
  assert.equal(build.architecture, process.arch);
  assert.equal(build.napiVersion, 8);
  assert.equal(build.binaryPath, "native-child-resource/binding.node");
  assert.equal(
    build.binarySha256,
    binary.sha256,
    "Native resource binding bytes differ",
  );
  assert.equal(build.selectedNodeHeaderClosureComplete, false);
  assert.equal(build.compilerSdkClosureVerified, false);
  assert.equal(build.completeNativeArtifactClosure, false);
  const binding = createRequire(import.meta.url)(binary.file);
  assert.equal(typeof binding.snapshot, "function");
  assert.deepEqual(Object.keys(binding), ["snapshot"]);
  assert.equal(
    (await capture("binding.node", 16 * 1024 * 1024)).sha256,
    binary.sha256,
    "Native resource binding changed during loading",
  );
  assert.equal(
    (await capture("build.json", 65536)).sha256,
    metadata.sha256,
    "Native resource build receipt changed during loading",
  );
  return Object.freeze({
    build: Object.freeze(build),
    snapshot: () =>
      parseNativeChildResourceSnapshot(
        Buffer.from(JSON.stringify(binding.snapshot()) + "\n"),
        { pid: process.pid, platform: process.platform },
      ),
  });
}
