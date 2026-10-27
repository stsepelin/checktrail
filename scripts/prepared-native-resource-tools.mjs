// Operator-only preparation for the synthetic native resource harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  ["counter/native-child-resource/build.json", 65536, 0o600],
  ["counter/native-child-resource/binding.node", 16 * 1048576, 0o700],
  ["observer/native-resource-observer/build.json", 65536, 0o600],
  ["observer/native-resource-observer/observer", 16 * 1048576, 0o700],
];
async function privateDirectory(directory, names) {
  assert.equal(
    await realpath(directory),
    directory,
    "Resource tools directory must not follow symlinks",
  );
  const stat = await lstat(directory);
  assert.ok(
    stat.isDirectory() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    "Resource tools directory must be private and caller owned",
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [...names].sort(),
    "Resource tools artifacts differ",
  );
}
async function capture(file, limit) {
  const before = await lstat(file);
  assert.equal(
    await realpath(file),
    file,
    "Prepared resource artifact must not follow symlinks",
  );
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === process.getuid() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= limit,
    "Prepared resource artifact must be bounded regular and caller owned",
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
    "Prepared resource artifact changed during capture",
  );
  return bytes;
}
export async function capturePreparedResourceTools(directory, headers) {
  const root = path.resolve(directory);
  await privateDirectory(root, ["counter", "observer"]);
  await privateDirectory(path.join(root, "counter"), ["native-child-resource"]);
  await privateDirectory(path.join(root, "observer"), [
    "native-resource-observer",
  ]);
  await privateDirectory(path.join(root, "counter/native-child-resource"), [
    "binding.node",
    "build.json",
  ]);
  await privateDirectory(path.join(root, "observer/native-resource-observer"), [
    "observer",
    "build.json",
  ]);
  const rows = [];
  for (const [file, limit, mode] of files)
    rows.push({
      file,
      mode,
      bytes: await capture(path.join(root, file), limit),
    });
  const counter = JSON.parse(rows[0].bytes.toString("utf8")),
    observer = JSON.parse(rows[2].bytes.toString("utf8"));
  for (const [build, source, binary, binaryPath] of [
    [
      counter,
      "native-child-resource.c",
      rows[1].bytes,
      "native-child-resource/binding.node",
    ],
    [
      observer,
      "native-resource-observer.c",
      rows[3].bytes,
      "native-resource-observer/observer",
    ],
  ]) {
    assert.equal(build.schemaVersion, 1);
    assert.equal(build.platform, process.platform);
    assert.equal(build.architecture, process.arch);
    assert.equal(
      build.sourceSha256,
      hash(await readFile(new URL(source, import.meta.url))),
      "Prepared native resource source differs",
    );
    assert.match(build.compilerSha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof build.compilerVersion, "string");
    assert.ok(
      build.compilerVersion.length > 0 && build.compilerVersion.length <= 1024,
    );
    assert.equal(
      build.binarySha256,
      hash(binary),
      "Prepared native resource binary differs",
    );
    assert.equal(build.binaryPath, binaryPath);
    assert.equal(build.compilerSdkClosureVerified, false);
    assert.equal(build.completeNativeArtifactClosure, false);
  }
  assert.equal(counter.compilerSha256, observer.compilerSha256);
  assert.equal(counter.compilerVersion, observer.compilerVersion);
  assert.equal(counter.napiVersion, 8);
  assert.equal(
    counter.preparedByNode,
    process.versions.node,
    "Prepared resource Node version differs",
  );
  assert.equal(
    counter.preparedByNodeExecutableSha256,
    hash(await readFile(await realpath(process.execPath))),
    "Prepared resource Node executable differs",
  );
  assert.equal(counter.selectedNodeHeaderClosureComplete, false);
  const names = [
    "js_native_api.h",
    "js_native_api_types.h",
    "node_api.h",
    "node_api_types.h",
    "node_version.h",
  ];
  assert.equal(await realpath(headers), path.resolve(headers));
  assert.deepEqual(
    counter.selectedNodeHeaders.map((row) => row.file),
    names,
  );
  for (const row of counter.selectedNodeHeaders) {
    const file = path.join(headers, row.file),
      bytes = await captureHeader(file);
    assert.equal(row.bytes, bytes.length);
    assert.equal(
      row.sha256,
      hash(bytes),
      "Prepared resource Node header differs",
    );
  }
  return { rows, builds: [counter, observer] };
}
async function captureHeader(file) {
  const before = await lstat(file);
  assert.equal(await realpath(file), file);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.size > 0 &&
      before.size <= 2 * 1048576,
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
  );
  return bytes;
}
export async function prepareNativeResourceTools(
  directory,
  headers,
  preparedDirectory = process.env.CHECKTRAIL_TEST_NATIVE_RESOURCE_TOOLS,
) {
  const canonical = path.resolve(directory);
  await privateDirectory(canonical, []);
  const selected =
    preparedDirectory === undefined
      ? undefined
      : await capturePreparedResourceTools(preparedDirectory, headers);
  const staging = await mkdtemp(
      path.join(canonical, ".resource-tools-staging-"),
    ),
    destination = path.join(canonical, "tools");
  try {
    if (selected) {
      for (const row of selected.rows) {
        await mkdir(path.dirname(path.join(staging, row.file)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(path.join(staging, row.file), row.bytes, {
          flag: "wx",
          mode: row.mode,
        });
      }
      assert.deepEqual(
        await capturePreparedResourceTools(preparedDirectory, headers),
        selected,
        "Prepared resource inputs changed before publication",
      );
    } else {
      await mkdir(path.join(staging, "counter"), { mode: 0o700 });
      await mkdir(path.join(staging, "observer"), { mode: 0o700 });
      for (const [script, args] of [
        [
          "prepare-native-child-resource.mjs",
          [path.join(staging, "counter"), headers],
        ],
        [
          "prepare-native-resource-observer.mjs",
          [path.join(staging, "observer")],
        ],
      ]) {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL(script, import.meta.url)), ...args],
          { encoding: "utf8", timeout: 45000, maxBuffer: 65536 },
        );
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const captured = await capturePreparedResourceTools(staging, headers);
    assert.deepEqual(
      await readdir(canonical),
      [path.basename(staging)],
      "Resource output directory changed before publication",
    );
    await rename(staging, destination);
    return {
      bundle: path.join(destination, "counter/native-child-resource"),
      observer: path.join(
        destination,
        "observer/native-resource-observer/observer",
      ),
      builds: captured.builds,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
